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

export const read = Effect.fn("SessionBudget.read")(function* (
  db: Database.Interface["db"],
  config: Config.Interface,
  sessionID: SessionSchema.ID,
) {
  const adjustment = yield* db
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
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  const budget = adjustment ? Schema.decodeUnknownSync(SessionEvent.Updated.data)(adjustment.data).budget : undefined
  if (budget) return { limit: budget.tokens, duration: budget.durationMs }
  const entries = yield* config.entries()
  const tokens = Config.latest(entries, "session_token_budget")
  const duration = Config.latest(entries, "session_duration_ms")
  return {
    limit: tokens === null ? undefined : (tokens ?? SessionOutcome.DefaultBudget.tokens),
    duration: duration === null ? undefined : (duration ?? SessionOutcome.DefaultBudget.durationMs),
  }
})
