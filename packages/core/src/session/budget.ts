export * as SessionBudget from "./budget"

import { DateTime, Effect, Option, Schema } from "effect"
import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm"
import { SessionOutcome } from "@zaovra-ai/schema/session-outcome"
import { Config } from "../config"
import { Database } from "../database/database"
import { EventTable } from "../event/sql"
import { EventV2 } from "../event"
import { SessionEvent } from "./event"
import { SessionSchema } from "./schema"
import { SessionInputTable, SessionTable } from "./sql"
import { Prompt } from "./prompt"
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
  // Existing interaction provenance predates the unlimited-duration decision.
  // Its implicit 12h wall remains until the user changes that axis explicitly.
  const wall =
    duration === null
      ? undefined
      : (duration ??
        (interactive && owner?.metadata?.budgetPolicy === 2 ? undefined : SessionOutcome.DefaultBudget.durationMs))
  const initial = Option.getOrUndefined(
    Schema.decodeUnknownOption(SessionOutcome.BudgetUpdate)(owner?.metadata?.creationBudget),
  )
  const updates = adjustments.map((entry) => Schema.decodeUnknownSync(SessionEvent.Updated.data)(entry.data))
  const tokenUpdate = updates.find((event) => event.budgetUpdate !== "patch" || Object.hasOwn(event.budget!, "tokens"))
  const durationUpdate = updates.find(
    (event) => event.budgetUpdate !== "patch" || Object.hasOwn(event.budget!, "durationMs"),
  )
  return {
    limit: tokenUpdate
      ? (tokenUpdate.budget?.tokens ?? undefined)
      : initial && Object.hasOwn(initial, "tokens")
        ? (initial.tokens ?? undefined)
        : limit,
    duration: durationUpdate
      ? (durationUpdate.budget?.durationMs ?? undefined)
      : initial && Object.hasOwn(initial, "durationMs")
        ? (initial.durationMs ?? undefined)
        : wall,
  }
})

export const requestPolicy = Effect.fn("SessionBudget.requestPolicy")(function* (
  db: Database.Interface["db"],
  sessionID: SessionSchema.ID,
) {
  const row = yield* db
    .select({ id: SessionInputTable.id, prompt: SessionInputTable.prompt })
    .from(SessionInputTable)
    .where(
      and(
        eq(SessionInputTable.session_id, sessionID),
        isNotNull(SessionInputTable.promoted_seq),
        isNull(SessionInputTable.cancelled_seq),
        isNull(SessionInputTable.completion),
      ),
    )
    .orderBy(desc(SessionInputTable.promoted_seq))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  if (!row) return
  return { requestID: row.id, policy: Schema.decodeUnknownSync(Prompt)(row.prompt).runPolicy }
})

/** One trusted bound for observation waits and fresh OS admission, not process lifetime. */
export const bounds = Effect.fn("SessionBudget.bounds")(function* (
  db: Database.Interface["db"],
  config: Config.Interface,
  sessionID: SessionSchema.ID,
) {
  const row = yield* db
    .select({ created: SessionTable.time_created, metadata: SessionTable.metadata })
    .from(SessionTable)
    .where(eq(SessionTable.id, sessionID))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  if (!row) return undefined
  const limits = yield* read(db, config, sessionID)
  const request = yield* requestPolicy(db, sessionID)
  const parent = Option.getOrUndefined(Schema.decodeUnknownOption(Schema.Finite)(row.metadata?.inheritedDeadline))
  const bounds = [
    limits.duration === undefined ? undefined : row.created + limits.duration,
    parent,
    request?.policy?.deadline,
  ].filter((value): value is number => value !== undefined)
  return { ...request, deadline: bounds.length ? Math.min(...bounds) : undefined }
})

/** Absolute host bound shared with children; changing a local axis cannot extend its parent. */
export function deadline(
  session: Pick<SessionSchema.Info, "time" | "inheritedDeadline">,
  duration: number | undefined,
  request?: number,
) {
  const parent = session.inheritedDeadline
  const own = duration === undefined ? undefined : DateTime.toEpochMillis(session.time.created) + duration
  const bound = parent === undefined ? own : own === undefined ? parent : Math.min(parent, own)
  return request === undefined ? bound : bound === undefined ? request : Math.min(request, bound)
}

/** Provider/tool admission ends before the host's cleanup reserve, never after it. */
export function closingDeadline(deadline: number | undefined, reserve = 0) {
  return deadline === undefined ? undefined : deadline - reserve
}

/** Yield the same job with up to 30s (at most half the remaining time) for closing work. */
export function observationDeadline(closingAt: number | undefined, now: number) {
  return closingAt === undefined ? undefined : closingAt - Math.min(30_000, Math.max(0, closingAt - now) / 2)
}

/** Restore only this budget window's provider stop. Clock sampling stays with the runner. */
export function stopState(input: {
  receipt: unknown
  deadline?: number
  closingReserveMs?: number
  providerDeadline?: number
  stopMessage?: string
  duration?: number
  elapsed: number
}) {
  const stopped =
    input.receipt !== null &&
    typeof input.receipt === "object" &&
    "providerDeadline" in input.receipt &&
    typeof input.receipt.providerDeadline === "number" &&
    "deadline" in input.receipt &&
    input.receipt.deadline === input.deadline &&
    "closingReserveMs" in input.receipt &&
    input.receipt.closingReserveMs === input.closingReserveMs
      ? input.receipt.providerDeadline
      : undefined
  const providerAt = input.providerDeadline ?? stopped
  return {
    providerAt,
    expired:
      (providerAt === undefined && !!input.stopMessage) ||
      (input.duration !== undefined && input.elapsed >= input.duration),
  }
}

/** Select the next budget action from observed time flags and durable reported usage. */
export function phase(input: {
  limit?: number
  total: number
  expired: boolean
  reserveReached: boolean
  notify: boolean
}) {
  if (input.limit === undefined && !input.expired && !input.reserveReached) return "continue"
  const closing = input.reserveReached && (input.limit === undefined || input.total < input.limit)
  if (!input.expired && !closing && input.limit !== undefined && input.total < input.limit)
    return !input.notify || input.total < input.limit * 0.75 ? "continue" : "notice"
  return closing ? "closing" : "expired"
}
