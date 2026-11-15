export * as SessionMemoryContext from "./memory-context"

import { and, asc, eq } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { SessionRequest } from "@zaovra-ai/schema/session-request"
import type { Database } from "../database/database"
import { MemoryTaskContext } from "../memory/task-context"
import { Hash } from "../util/hash"
import { SessionContextEpoch } from "./context-epoch"
import { SessionMessage } from "./message"
import type { SessionSchema } from "./schema"
import { SessionMessageTable } from "./sql"

/** Only promoted durable user messages define a task, never inbox or host results. */
export const load = Effect.fn("SessionMemoryContext.load")(function* (
  db: Database.Interface["db"],
  memory: MemoryTaskContext.Interface,
  sessionID: SessionSchema.ID,
) {
  const rows = yield* db
    .select()
    .from(SessionMessageTable)
    .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, "user")))
    .orderBy(asc(SessionMessageTable.seq))
    .all()
    .pipe(Effect.orDie)
  const request = SessionRequest.requested(
    rows.map((row) => Schema.decodeUnknownSync(SessionMessage.User)({ ...row.data, id: row.id, type: row.type })),
    Hash.sha256,
  )
  const text = request.entries
    .filter((entry) => !entry.withdrawnBy && !entry.data)
    .map((entry) => entry.text)
    .join("\n")
    .slice(0, 4000)
  return yield* memory.load(
    request.sourceMessageID ? { id: request.sourceMessageID + ":" + Hash.sha256(text), text } : undefined,
    yield* SessionContextEpoch.sourceValue(db, sessionID, MemoryTaskContext.key),
  )
})
