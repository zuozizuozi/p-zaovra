export * as SessionMessageTurn from "./message-turn"

import { and, eq, sql } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "../database/database"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { SessionMessageTable } from "./sql"

/**
 * The turn a stored message belongs to. A user message is its own turn, including one written
 * before turns were recorded.
 */
export const of = Effect.fn("SessionMessageTurn.of")(function* (
  db: Database.Interface["db"],
  sessionID: SessionSchema.ID,
  messageID: SessionMessage.ID,
) {
  const row = yield* db
    .select({ type: SessionMessageTable.type, turn: sql<unknown>`json_extract(${SessionMessageTable.data}, '$.turn')` })
    .from(SessionMessageTable)
    .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.id, messageID)))
    .get()
    .pipe(Effect.orDie)
  if (!row) return undefined
  if (typeof row.turn === "string") return SessionMessage.ID.make(row.turn)
  return row.type === "user" ? messageID : undefined
})
