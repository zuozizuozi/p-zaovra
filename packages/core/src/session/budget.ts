export * as SessionBudget from "./budget"

import { Effect, Schema } from "effect"
import { and, desc, eq, sql } from "drizzle-orm"
import { SessionOutcome } from "@zaovra-ai/schema/session-outcome"
import { Config } from "../config"
import { Database } from "../database/database"
import { EventTable } from "../event/sql"
import { EventV2 } from "../event"
import { SessionEvent } from "./event"
import { SessionSchema } from "./schema"
import { SessionTable } from "./sql"
import { WorkAttemptTable } from "../work/sql"

export const read = Effect.fn("SessionBudget.read")(function* (
  db: Database.Interface["db"],
  config: Config.Interface,
  sessionID: SessionSchema.ID,
) {
  const adjustments = yield* db
    .select({ data: EventTable.data })
    .from(EventTable)
    .where(
      and(
        eq(EventTable.aggregate_id, sessionID),
        eq(
          EventTable.type,
          EventV2.versionedType(SessionEvent.Updated.type, SessionEvent.Updated.durable?.version ?? 1),
        ),
        sql`json_type(${EventTable.data}, '$.budget') = 'object'`,
      ),
    )
    .orderBy(desc(EventTable.seq))
    .all()
    .pipe(Effect.orDie)
  const entries = yield* config.entries()
  const tokens = Config.latest(entries, "session_token_budget")
  const duration = Config.latest(entries, "session_duration_ms")
  const owner = yield* db
    .select({ metadata: SessionTable.metadata, attempt: WorkAttemptTable.id })
    .from(SessionTable)
    .leftJoin(WorkAttemptTable, eq(WorkAttemptTable.session_id, SessionTable.id))
    .where(eq(SessionTable.id, sessionID))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  // Only creation provenance proves interaction; parentage alone proves neither
  // mode. Legacy/missing projections conservatively retain the old 30M default.
  // Any WorkAttempt association wins, including finished/cancelled attempts.
  const interactive = !owner?.attempt && owner?.metadata?.budgetMode === "interactive"
  const limit =
    tokens === null ? undefined : (tokens ?? (interactive ? undefined : SessionOutcome.DefaultBudget.tokens))
  const wall = duration === null ? undefined : (duration ?? SessionOutcome.DefaultBudget.durationMs)
  const updates = adjustments.map((entry) => Schema.decodeUnknownSync(SessionEvent.Updated.data)(entry.data))
  const tokenUpdate = updates.find((event) => event.budgetUpdate !== "patch" || Object.hasOwn(event.budget!, "tokens"))
  const durationUpdate = updates.find(
    (event) => event.budgetUpdate !== "patch" || Object.hasOwn(event.budget!, "durationMs"),
  )
  return {
    limit: tokenUpdate ? (tokenUpdate.budget?.tokens ?? undefined) : limit,
    duration: durationUpdate ? (durationUpdate.budget?.durationMs ?? undefined) : wall,
  }
})
