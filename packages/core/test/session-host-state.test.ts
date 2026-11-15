import { expect, test } from "bun:test"
import path from "node:path"
import { DateTime, Effect, Exit, ManagedRuntime, Schema } from "effect"
import { eq, asc } from "drizzle-orm"
import { SessionHostState } from "@zaovra-ai/schema/session-host-state"
import { SessionHost } from "../src/session/host-state"
import { DeliveryContract } from "../src/session/delivery-contract"
import { ClosingReview } from "../src/session/closing-review"
import { SessionProgress } from "../src/session/progress"
import { SessionMessage } from "../src/session/message"
import { SessionEvent } from "../src/session/event"
import { SessionSchema } from "../src/session/schema"
import { SessionProjector } from "../src/session/projector"
import { SessionMessageTable, SessionTable } from "../src/session/sql"
import { Database } from "../src/database/database"
import { EventV2 } from "../src/event"
import { EventTable } from "../src/event/sql"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { Project } from "../src/project"
import { ProjectTable } from "../src/project/sql"
import { AbsolutePath } from "../src/schema"
import { tmpdir } from "./fixture/tmpdir"

const receipt = { request: "request-a", started: 10, tokens: 256, decision: "consumed", missing: [] } as const
const synthetic = (text: string, host?: Schema.Json) =>
  SessionMessage.Synthetic.make({
    id: SessionMessage.ID.create(),
    sessionID: SessionSchema.ID.make("ses_host"),
    type: "synthetic",
    text,
    ...(host === undefined ? {} : { host }),
    time: { created: DateTime.makeUnsafe(0) },
  })

test("typed receipt is authoritative across mixed history and request boundaries", () => {
  const old = synthetic(DeliveryContract.prefix + JSON.stringify({ ...receipt, decision: "repair" }))
  const current = synthetic(old.text, { version: 1, kind: "delivery", receipt })
  expect(DeliveryContract.receipt([old], receipt.request)?.decision).toBe("repair")
  expect(DeliveryContract.receipt([old, current], receipt.request)?.decision).toBe("consumed")
  expect(DeliveryContract.receipt([old, current, current], receipt.request)?.decision).toBe("consumed")
  expect(DeliveryContract.receipt([old, current], "request-b")).toBeUndefined()
  expect(
    DeliveryContract.receipt([synthetic("translated", { version: 1, kind: "delivery", receipt })], receipt.request)
      ?.decision,
  ).toBe("consumed")
  expect(
    DeliveryContract.receipt([old, synthetic(old.text, { version: 9, kind: "delivery", receipt })], receipt.request)
      ?.decision,
  ).toBe("unverified")
  expect(SessionHost.invalid({ host: { version: 9, kind: "delivery", receipt } })).toBe(true)
  expect(SessionHost.invalid({})).toBe(false)
})

test("budget and verification state do not infer authority from new display text", () => {
  expect(SessionHost.checkpoint({ text: "translated", host: { version: 1, kind: "budget-checkpoint" } })).toBe(true)
  expect(SessionHost.notice({ text: "translated", host: { version: 1, kind: "budget-notice", limit: 100 } }, 100)).toBe(
    true,
  )
  expect(
    SessionHost.notice(
      { text: "Session token budget notice (limit=200):", host: { version: 1, kind: "budget-notice", limit: 100 } },
      200,
    ),
  ).toBe(false)
  const closing = {
    requestID: "request-a",
    sourceMessageID: "source",
    deadline: 100,
    closingReserveMs: 20,
    providerDeadline: 70,
    state: "stopped_unverified",
    cancelled: [],
    preserved: [],
  }
  expect(
    SessionHost.closing(
      { text: "translated", host: { version: 1, kind: "budget-closing", receipt: closing } },
      "request-a",
      "source",
    ),
  ).toEqual(closing)
  expect(
    SessionHost.closing(
      { text: "translated", host: { version: 1, kind: "budget-closing", receipt: closing } },
      "request-b",
    ),
  ).toBeUndefined()
  expect(
    SessionHost.closing(
      { text: "[host.run.closing] source:request-a " + JSON.stringify(closing) },
      "request-a",
      "source",
    ),
  ).toEqual(closing)
  expect(
    ClosingReview.legacyDue(true, [
      {
        data: {
          text: "translated",
          host: { version: 1, kind: "verification", request: "a", mode: "legacy", gaps: [] },
        },
      },
    ]),
  ).toBe(false)
  expect(ClosingReview.legacyDue(true, [{ data: { text: "Verification closing review: old" } }])).toBe(false)
  expect(
    ClosingReview.legacyDue(true, [
      { data: { text: "Verification closing review: misleading", host: { version: 1, kind: "budget-checkpoint" } } },
    ]),
  ).toBe(true)
})

test("facts throttle reads typed snapshot even when text is changed", () => {
  const input = {
    now: 1000,
    state: { activeMs: 100, request: "a", requestStarted: 0 },
    turns: 2,
    step: 2,
    tokens: 10,
    unreported: 0,
  }
  const snapshot = SessionProgress.snapshot(input)
  expect(SessionProgress.factsDue(input, { text: "translated", host: { version: 1, kind: "facts", snapshot } })).toBe(
    false,
  )
  expect(
    SessionProgress.factsDue(
      { ...input, state: { ...input.state, request: "b" } },
      { text: "translated", host: { version: 1, kind: "facts", snapshot } },
    ),
  ).toBe(true)
  expect(SessionProgress.factsDue(input, SessionProgress.facts(input))).toBe(false)
  const encoded = Schema.encodeSync(SessionMessage.Synthetic)(synthetic("old"))
  expect(encoded).not.toHaveProperty("host")
  const unknown = { version: 42, kind: "delivery", future: { raw: "keep" } }
  expect(Schema.decodeUnknownSync(SessionHostState.Stored)(unknown)).toEqual(unknown)
})

const sessionID = SessionSchema.ID.make("ses_host_persistent")
const runtime = (file: string) =>
  ManagedRuntime.make(
    AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node]), [
      [Database.node, Database.layerFromPath(file)],
    ]),
  )
const seed = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: "host",
      directory: "/project",
      title: "host",
      version: "test",
    })
    .run()
    .pipe(Effect.orDie)
})

test("SQLite reopens with atomic text/state; replay duplicates and out-of-order events cannot diverge", async () => {
  await using temp = await tmpdir()
  const file = path.join(temp.path, "host.db")
  const first = runtime(file)
  const saved = await first
    .runPromise(
      Effect.gen(function* () {
        yield* seed
        const events = yield* EventV2.Service
        const { db } = yield* Database.Service
        const messageID = SessionMessage.ID.create()
        const data = { sessionID, messageID, timestamp: DateTime.makeUnsafe(0), ...SessionHost.delivery(receipt) }
        const failed = yield* events
          .publish(SessionEvent.Synthetic, data, { commit: () => Effect.die("atomic-failure") })
          .pipe(Effect.exit)
        expect(Exit.isFailure(failed)).toBe(true)
        expect(yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, sessionID)).all()).toHaveLength(0)
        expect(
          yield* db.select().from(SessionMessageTable).where(eq(SessionMessageTable.session_id, sessionID)).all(),
        ).toHaveLength(0)
        yield* events.publish(SessionEvent.Synthetic, data)
        const rows = yield* db
          .select()
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, sessionID))
          .orderBy(asc(EventTable.seq))
          .all()
        return rows.map((row) => ({
          id: row.id,
          aggregateID: row.aggregate_id,
          seq: row.seq,
          type: row.type,
          data: row.data,
        }))
      }),
    )
    .finally(() => first.dispose())
  const second = runtime(file)
  await second
    .runPromise(
      Effect.gen(function* () {
        const events = yield* EventV2.Service
        const { db } = yield* Database.Service
        yield* events.replayAll(saved)
        yield* events.replayAll(saved)
        const before = yield* db
          .select()
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.session_id, sessionID))
          .all()
        expect(before).toHaveLength(1)
        expect(before[0]!.data).toMatchObject({
          text: DeliveryContract.prefix + JSON.stringify(receipt),
          host: { version: 1, kind: "delivery", receipt },
        })
        const bad = yield* events.replay({ ...saved[0]!, id: EventV2.ID.create(), seq: 3 }).pipe(Effect.exit)
        expect(Exit.isFailure(bad)).toBe(true)
        expect(
          yield* db.select().from(SessionMessageTable).where(eq(SessionMessageTable.session_id, sessionID)).all(),
        ).toEqual(before)
        yield* events.publish(SessionEvent.ContextUpdated, {
          sessionID,
          messageID: SessionMessage.ID.create(),
          timestamp: DateTime.makeUnsafe(1),
          text: "facts",
          host: {
            version: 1,
            kind: "facts",
            snapshot: SessionProgress.snapshot({
              now: 0,
              state: { activeMs: 0, request: "a", requestStarted: 0 },
              turns: 1,
              step: 1,
              tokens: 1,
              unreported: 0,
            }),
          },
        })
      }),
    )
    .finally(() => second.dispose())
  const third = runtime(file)
  await third
    .runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const rows = yield* db
          .select()
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.session_id, sessionID))
          .orderBy(asc(SessionMessageTable.seq))
          .all()
        expect(rows).toHaveLength(2)
        expect(SessionHost.read(rows[1]!.data as { host?: unknown })?.kind).toBe("facts")
      }),
    )
    .finally(() => third.dispose())
})

test("faults on either side of a diagnostic cannot split authoritative prompt state", async () => {
  await using temp = await tmpdir()
  const live = runtime(path.join(temp.path, "atomic.db"))
  await live
    .runPromise(
      Effect.gen(function* () {
        yield* seed
        const events = yield* EventV2.Service
        const { db } = yield* Database.Service
        const host = { version: 1, kind: "verification", mode: "evidence", request: "a", key: "k", gaps: [] } as const
        const decision = { version: 1, kind: "verification-decision", key: "k", decision: "review", gaps: [] } as const
        yield* events.publish(SessionEvent.QualityProgress, {
          sessionID,
          timestamp: DateTime.makeUnsafe(0),
          category: "closing",
          details: { key: "k", decision: "review" },
          host: decision,
        })
        const rejected = yield* events
          .publish(
            SessionEvent.Synthetic,
            {
              sessionID,
              timestamp: DateTime.makeUnsafe(0),
              messageID: SessionMessage.ID.create(),
              text: "translated",
              host,
            },
            { commit: () => Effect.die("before-prompt-commit") },
          )
          .pipe(Effect.exit)
        expect(Exit.isFailure(rejected)).toBe(true)
        expect(
          yield* db.select().from(SessionMessageTable).where(eq(SessionMessageTable.session_id, sessionID)).all(),
        ).toHaveLength(0)
        yield* events.publish(SessionEvent.Synthetic, {
          sessionID,
          timestamp: DateTime.makeUnsafe(0),
          messageID: SessionMessage.ID.create(),
          text: "translated",
          host,
        })
        const after = yield* events
          .publish(
            SessionEvent.QualityProgress,
            {
              sessionID,
              timestamp: DateTime.makeUnsafe(1),
              category: "closing",
              details: { key: "k", decision: "review" },
              host: decision,
            },
            { commit: () => Effect.die("after-prompt-commit") },
          )
          .pipe(Effect.exit)
        expect(Exit.isFailure(after)).toBe(true)
        const rows = yield* db
          .select()
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.session_id, sessionID))
          .all()
        expect(rows).toHaveLength(1)
        expect(rows[0]!.data).toMatchObject({ text: "translated", host })
        expect(yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, sessionID)).all()).toHaveLength(2)
      }),
    )
    .finally(() => live.dispose())
})

test("invalid evidence identity and raw future fields stay readable without legacy fallback", () => {
  expect(SessionHost.invalid({ host: { version: 1, kind: "verification", mode: "evidence", gaps: [] } })).toBe(true)
  const raw = { version: 1, kind: "budget-notice", limit: -1, extra: { original: "keep" } }
  expect(Schema.decodeUnknownSync(SessionHostState.Stored)(raw)).toEqual(raw)
  expect(SessionHost.invalid({ host: raw })).toBe(true)
  const legacy = synthetic(DeliveryContract.prefix + JSON.stringify({ ...receipt, decision: "repair" }))
  expect(DeliveryContract.receipt([legacy, synthetic("untrusted display", raw)], receipt.request)?.decision).toBe(
    "unverified",
  )
})
