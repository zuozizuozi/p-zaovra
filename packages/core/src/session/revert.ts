export * as SessionRevert from "./revert"

import { and, asc, eq, gt } from "drizzle-orm"
import { DateTime, Effect, Schema } from "effect"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { RelativePath } from "../schema"
import { Location } from "../location"
import { Revert } from "@zaovra-ai/schema/revert"
import { Hash } from "../util/hash"
import { Snapshot } from "../snapshot"
import { SessionEvent } from "./event"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { SessionMessageTable } from "./sql"

export class MessageNotFoundError extends Schema.TaggedErrorClass<MessageNotFoundError>()(
  "Session.MessageNotFoundError",
  {
    sessionID: SessionSchema.ID,
    messageID: SessionMessage.ID,
  },
) {}

interface BoundaryInput {
  readonly sessionID: SessionSchema.ID
  readonly messageID: SessionMessage.ID
}

export class PlanChangedError extends Schema.TaggedErrorClass<PlanChangedError>()("Session.RevertPlanChangedError", {
  sessionID: SessionSchema.ID,
}) {}

const selectFiles = Effect.fn("SessionRevert.selectFiles")(function* (input: BoundaryInput) {
  const db = (yield* Database.Service).db
  const boundary = yield* db
    .select({ seq: SessionMessageTable.seq })
    .from(SessionMessageTable)
    .where(and(eq(SessionMessageTable.session_id, input.sessionID), eq(SessionMessageTable.id, input.messageID)))
    .get()
    .pipe(Effect.orDie)
  if (!boundary) return yield* new MessageNotFoundError(input)
  const rows = yield* db
    .select()
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, input.sessionID),
        eq(SessionMessageTable.type, "assistant"),
        gt(SessionMessageTable.seq, boundary.seq),
      ),
    )
    .orderBy(asc(SessionMessageTable.seq))
    .all()
    .pipe(Effect.orDie)
  const decode = Schema.decodeUnknownEffect(SessionMessage.Message)
  const files = new Map<RelativePath, Snapshot.ID>()
  for (const row of rows) {
    const message = yield* decode({ ...row.data, id: row.id, type: row.type }).pipe(Effect.orDie)
    if (message.type !== "assistant" || !message.snapshot?.start) continue
    for (const file of message.snapshot.files ?? [])
      if (!files.has(file)) files.set(file, Snapshot.ID.make(message.snapshot.start))
  }
  return files
})

// The same selection drives preview and execution. Reading a plan must not
// capture a snapshot, publish events, or interrupt a running session.
const prepare = Effect.fn("SessionRevert.prepare")(function* (input: {
  readonly session: SessionSchema.Info
  readonly messageID: SessionMessage.ID
  readonly files?: boolean
  readonly coverage: Revert.Plan["coverage"]
}) {
  const next = yield* selectFiles({ sessionID: input.session.id, messageID: input.messageID })
  const restore = new Map<RelativePath, Snapshot.ID>()
  const original = input.session.revert?.snapshot
  if (original) for (const file of input.session.revert?.files ?? []) restore.set(file.path, Snapshot.ID.make(original))
  if (input.files !== false) for (const [file, tree] of next) restore.set(file, tree)
  const plan = {
    messageID: input.messageID,
    files: Array.from(restore.keys()).sort(),
    coverage: input.coverage,
    token: Hash.sha256(
      JSON.stringify([
        input.session.id,
        input.messageID,
        input.files !== false,
        input.coverage,
        original,
        [...restore],
      ]),
    ),
  } satisfies Revert.Plan
  return { next, restore, plan }
})

export const plan = Effect.fn("SessionRevert.plan")(function* (input: Parameters<typeof prepare>[0]) {
  return (yield* prepare(input)).plan
})

// Reconstruct the post-reset state from durable message snapshots, including
// paths absent from their selected tree. This also survives a process restart.
const expectedFiles = Effect.fn("SessionRevert.expectedFiles")(function* (session: SessionSchema.Info) {
  if (!session.revert?.files?.length) return
  const location = yield* Location.Service
  if (location.vcs?.type !== "git") return
  const selected = yield* selectFiles({ sessionID: session.id, messageID: session.revert.messageID }).pipe(
    Effect.catchTag(
      "Session.MessageNotFoundError",
      () =>
        new Snapshot.Error({
          operation: "restore",
          message: "Cannot verify the files after this reset. No files were restored.",
        }),
    ),
  )
  const expected = new Map<RelativePath, Snapshot.ID>()
  for (const file of session.revert.files) {
    const tree = selected.get(file.path)
    if (!tree)
      return yield* new Snapshot.Error({
        operation: "restore",
        message: "Cannot verify the files after this reset. No files were restored.",
      })
    expected.set(file.path, tree)
  }
  return expected
})

export const stage = Effect.fn("SessionRevert.stage")(function* (input: {
  readonly session: SessionSchema.Info
  readonly messageID: SessionMessage.ID
  readonly files?: boolean
  readonly planToken?: string
}) {
  const location = yield* Location.Service
  const prepared = yield* prepare({ ...input, coverage: location.vcs?.type === "git" ? "snapshot" : "file-tools" })
  if (input.planToken !== undefined && input.planToken !== prepared.plan.token)
    return yield* new PlanChangedError({ sessionID: input.session.id })
  const snapshot = yield* Snapshot.Service
  const events = yield* EventV2.Service
  const original = input.session.revert?.snapshot
    ? Snapshot.ID.make(input.session.revert.snapshot)
    : yield* snapshot.capture({ sessionID: input.session.id })
  if (prepared.restore.size && !original)
    return yield* new Snapshot.Error({
      operation: "restore",
      message: "Could not back up the current files. No files were restored.",
    })
  if (prepared.restore.size)
    yield* snapshot.restore({ files: prepared.restore, expected: yield* expectedFiles(input.session) })
  const paths = input.files === false ? [] : Array.from(prepared.next.keys())
  const files = original
    ? yield* snapshot.diff({
        from: original,
        to: (yield* snapshot.capture({ sessionID: input.session.id })) ?? original,
        paths,
      })
    : []
  const revert = {
    messageID: input.messageID,
    snapshot: original,
    diff: files
      .map((file) => file.patch)
      .join("")
      .trim(),
    files,
  } satisfies SessionSchema.Info["revert"]
  yield* events.publish(SessionEvent.RevertEvent.Staged, {
    sessionID: input.session.id,
    timestamp: yield* DateTime.now,
    revert,
  })
  return revert
})

export const clear = Effect.fn("SessionRevert.clear")(function* (session: SessionSchema.Info) {
  if (!session.revert) return
  const snapshot = yield* Snapshot.Service
  const original = session.revert.snapshot ? Snapshot.ID.make(session.revert.snapshot) : undefined
  if (original && session.revert.files?.length)
    yield* snapshot.restore({
      files: new Map((session.revert.files ?? []).map((file) => [file.path, original])),
      expected: yield* expectedFiles(session),
    })
  const events = yield* EventV2.Service
  yield* events.publish(SessionEvent.RevertEvent.Cleared, {
    sessionID: session.id,
    timestamp: yield* DateTime.now,
  })
})

export const commit = Effect.fn("SessionRevert.commit")(function* (session: SessionSchema.Info) {
  if (!session.revert) return
  const events = yield* EventV2.Service
  yield* events.publish(SessionEvent.RevertEvent.Committed, {
    sessionID: session.id,
    messageID: session.revert.messageID,
    timestamp: yield* DateTime.now,
  })
})
