export * as SessionTurnDiff from "./turn-diff"

import { and, asc, eq, gt, lt } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { Database } from "../database/database"
import { Snapshot } from "../snapshot"
import { SessionMessage } from "./message"
import { SessionMessageTable } from "./sql"
import { SessionSchema } from "./schema"
import { MessageNotFoundError } from "./revert"

export const plan = Effect.fn("SessionTurnDiff.plan")(function* (input: {
  sessionID: SessionSchema.ID
  messageID: SessionMessage.ID
}) {
  const database = yield* Database.Service
  const boundary = yield* database.db
    .select({ seq: SessionMessageTable.seq })
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, input.sessionID),
        eq(SessionMessageTable.id, input.messageID),
        eq(SessionMessageTable.type, "user"),
      ),
    )
    .get()
    .pipe(Effect.orDie)
  if (!boundary) return yield* new MessageNotFoundError(input)
  const next = yield* database.db
    .select({ seq: SessionMessageTable.seq })
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, input.sessionID),
        eq(SessionMessageTable.type, "user"),
        gt(SessionMessageTable.seq, boundary.seq),
      ),
    )
    .orderBy(asc(SessionMessageTable.seq))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  const rows = yield* database.db
    .select()
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, input.sessionID),
        eq(SessionMessageTable.type, "assistant"),
        gt(SessionMessageTable.seq, boundary.seq),
        next ? lt(SessionMessageTable.seq, next.seq) : undefined,
      ),
    )
    .orderBy(asc(SessionMessageTable.seq))
    .all()
    .pipe(Effect.orDie)
  const messages = rows.map((row) =>
    Schema.decodeUnknownSync(SessionMessage.Message)({ ...row.data, id: row.id, type: row.type }),
  )
  const snapshots = messages.flatMap((message) =>
    message.type === "assistant" && message.snapshot?.start && message.snapshot.end ? [message.snapshot] : [],
  )
  const from = snapshots[0]?.start
  const to = snapshots.at(-1)?.end
  if (!from || !to) return
  return {
    from: Snapshot.ID.make(from),
    to: Snapshot.ID.make(to),
    paths: [...new Set(snapshots.flatMap((snapshot) => snapshot.files ?? []))],
  }
})

export const diff = Effect.fn("SessionTurnDiff.diff")(function* (input: Parameters<typeof plan>[0]) {
  const comparison = yield* plan(input)
  if (!comparison || comparison.paths.length === 0) return []
  const snapshot = yield* Snapshot.Service
  return yield* snapshot.diff(comparison)
})
