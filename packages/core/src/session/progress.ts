export * as SessionProgress from "./progress"

import { DateTime, Effect, Schema } from "effect"
import { eq, sql } from "drizzle-orm"
import type { Database } from "../database/database"
import { SessionTable } from "./sql"
import { SessionSchema } from "./schema"
import { EventV2 } from "../event"
import { SessionEvent } from "./event"

export const State = Schema.Struct({
  activeMs: Schema.Number,
  request: Schema.String,
  requestStarted: Schema.Number,
  draining: Schema.optional(Schema.Boolean),
  activeTimeUnknown: Schema.optional(Schema.Boolean),
})

export function advance(
  previous: typeof State.Type | undefined,
  input: { now: number; active: number; request: string },
) {
  return {
    ...(previous?.draining === undefined ? {} : { draining: previous.draining }),
    ...(previous?.activeTimeUnknown ? { activeTimeUnknown: true } : {}),
    activeMs: (previous?.activeMs ?? 0) + Math.max(0, input.active),
    request: input.request,
    requestStarted: previous?.request === input.request ? previous.requestStarted : input.now,
  }
}

export const read = Effect.fn("SessionProgress.read")(function* (db: Database.Interface["db"], id: SessionSchema.ID) {
  const row = yield* db
    .select({ metadata: SessionTable.metadata })
    .from(SessionTable)
    .where(eq(SessionTable.id, id))
    .get()
    .pipe(Effect.orDie)
  return Schema.decodeUnknownOption(State)(row?.metadata?.qualityProgress)
})

export const save = Effect.fn("SessionProgress.save")(function* (
  db: Database.Interface["db"],
  id: SessionSchema.ID,
  state: typeof State.Type,
) {
  yield* db
    .update(SessionTable)
    .set({
      metadata: sql`json_set(coalesce(${SessionTable.metadata}, '{}'), '$.qualityProgress', json(${JSON.stringify(state)}))`,
    })
    .where(eq(SessionTable.id, id))
    .run()
    .pipe(Effect.orDie)
})

export function facts(input: {
  now: number
  state: typeof State.Type
  turns: number
  step: number
  limit: number
  tokens: number
  unreported: number
  budget?: number
  deadline?: number
}) {
  const reminder =
    (input.budget !== undefined && input.tokens >= input.budget * 0.75) ||
    (input.deadline !== undefined && input.deadline - input.now <= 60_000)
  return `Current task facts (host observations, not new requirements): ${JSON.stringify({
    requestElapsedMs: Math.max(0, input.now - input.state.requestStarted),
    activeMs: input.state.activeMs,
    ...(input.state.activeTimeUnknown ? { activeTimeUnknown: true } : {}),
    providerTurns: input.turns,
    allowanceTurn: input.step,
    allowanceLimit: input.limit,
    knownTokens: input.tokens,
    unreported: input.unreported,
    ...(input.budget === undefined
      ? {}
      : input.unreported
        ? { remainingTokenUpperBound: Math.max(0, input.budget - input.tokens) }
        : { remainingTokens: Math.max(0, input.budget - input.tokens) }),
    ...(input.deadline === undefined ? {} : { remainingMs: Math.max(0, input.deadline - input.now) }),
  })}${reminder ? "\n保留当前可运行产物，先补最小验收缺口。Do not omit requirements or necessary validation." : ""}`
}

export function reviewDecision(input: { key: string; previous: readonly string[]; missing: readonly string[] }) {
  if (!input.previous.includes(input.key)) return "review"
  return input.missing.length ? "unverified" : "finish"
}

export const FailureObservation = Schema.Struct({
  category: Schema.String,
  error: Schema.String,
  cwd: Schema.String,
  environment: Schema.optional(Schema.String),
  artifact: Schema.optional(Schema.String),
  hypothesis: Schema.optional(Schema.String),
  expectedEvidence: Schema.optional(Schema.String),
  evidence: Schema.optional(Schema.String),
})

export type Failure = {
  category: string
  error: string
  cwd: string
  environment?: string
  artifact?: string
  hypothesis?: string
  expectedEvidence?: string
  evidence?: string
}

export function stagnation(previous: Failure | undefined, current: Failure) {
  const signature = JSON.stringify([current.category, current.error, current.cwd, current.environment ?? null])
  const comparable =
    current.environment !== undefined &&
    current.artifact !== undefined &&
    current.hypothesis !== undefined &&
    current.evidence !== undefined
  return {
    signature,
    candidate:
      comparable &&
      previous !== undefined &&
      JSON.stringify([previous.category, previous.error, previous.cwd, previous.environment ?? null]) === signature &&
      previous.artifact === current.artifact &&
      previous.hypothesis === current.hypothesis &&
      previous.evidence === current.evidence,
    expectedEvidence: current.expectedEvidence ?? "unknown",
    intervention: false,
  }
}

export const independentReview =
  "Identify the original source for each critical assumption. Check the actual end-to-end result against that source. State unverified scope and why; self-written tests or another model's agreement are not independent proof."

export const record = Effect.fn("SessionProgress.record")(function* (
  events: EventV2.Interface,
  sessionID: SessionSchema.ID,
  category: "continuation" | "closing" | "stagnation",
  details: Schema.Json,
) {
  yield* events.publish(SessionEvent.QualityProgress, { sessionID, timestamp: yield* DateTime.now, category, details })
})
