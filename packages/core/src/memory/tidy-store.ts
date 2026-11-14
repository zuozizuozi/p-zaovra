export * as MemoryTidyStore from "./tidy-store"

import { randomUUID } from "node:crypto"
import { and, desc, eq, sql } from "drizzle-orm"
import { Cause, Clock, Context, Effect, Layer, Schema } from "effect"
import { isSqlError, type SqlError } from "effect/unstable/sql/SqlError"
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core/errors"
import type { Memory } from "@zaovra-ai/schema/memory"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import type { ModelV2 } from "../model"
import { SessionSchema } from "../session/schema"
import { SessionInputTable, SessionTable } from "../session/sql"
import { MemoryTidyAttemptTable, MemoryTidyDayTable, MemoryTidyRunTable } from "./tidy.sql"

export const defaults = { tokens: 200_000, dailyTokens: 1_000_000 } as const
export type Run = typeof MemoryTidyRunTable.$inferSelect
export type Usage = { known: number; reserved: number; charged: number; unknown: number }
export type Request = {
  requestID: string
  scope: Memory.Scope
  directory: string
  model: ModelV2.Ref
  tokens: number
  dailyTokens: number
}
export type Authority = { sessionID: SessionSchema.ID; scope: Memory.Scope; enabled: boolean }

export class Rejected extends Schema.TaggedErrorClass<Rejected>()("MemoryTidy.Rejected", {
  reason: Schema.Literals(["invalid", "conflict", "unauthorized", "limit", "duplicate", "missing", "busy"]),
}) {}

export interface Interface {
  readonly create: (
    input: Request,
    createSession: (id: SessionSchema.ID) => Effect.Effect<void | NonNullable<Run["input"]>>,
  ) => Effect.Effect<Run, Rejected>
  readonly get: (id: string) => Effect.Effect<Run | undefined>
  readonly forSession: (sessionID: SessionSchema.ID) => Effect.Effect<Run | undefined>
  readonly list: (scope: Memory.Scope) => Effect.Effect<Run[]>
  readonly ownsSession: (run: Run) => Effect.Effect<boolean>
  readonly authorize: (input: Authority) => Effect.Effect<Run, Rejected>
  readonly guarded: <A>(input: Authority, operation: Effect.Effect<A>) => Effect.Effect<A, Rejected>
  readonly reserve: (input: Authority & { attemptID: string; tokens: number }) => Effect.Effect<void, Rejected>
  readonly settle: (attemptID: string, actual: number) => Effect.Effect<{ exceeded: boolean }, Rejected>
  readonly finish: (id: string, state: "completed" | "cancelled" | "failed") => Effect.Effect<void, Rejected>
  readonly usage: (input: { runID: string } | { day: string }) => Effect.Effect<Usage>
}

export class Service extends Context.Service<Service, Interface>()("@zaovra/MemoryTidyStore") {}

const integer = (value: number) => Number.isSafeInteger(value) && value >= 0
const modelKey = (model: { id: string; providerID: string; variant?: string }) =>
  JSON.stringify([model.providerID, model.id, model.variant ?? "default"])

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const db = database.db
    const get = (id: string) => db.select().from(MemoryTidyRunTable).where(eq(MemoryTidyRunTable.id, id)).get()
    const usage = (input: { runID: string } | { day: string }) =>
      db
        .select({
          known: sql<number>`coalesce(sum(${MemoryTidyAttemptTable.actual}), 0)`,
          reserved: sql<number>`coalesce(sum(case when ${MemoryTidyAttemptTable.actual} is null then ${MemoryTidyAttemptTable.reserved} else 0 end), 0)`,
          charged: sql<number>`coalesce(sum(coalesce(${MemoryTidyAttemptTable.actual}, ${MemoryTidyAttemptTable.reserved})), 0)`,
          unknown: sql<number>`coalesce(sum(case when ${MemoryTidyAttemptTable.actual} is null then 1 else 0 end), 0)`,
        })
        .from(MemoryTidyAttemptTable)
        .where(
          "runID" in input ? eq(MemoryTidyAttemptTable.run_id, input.runID) : eq(MemoryTidyAttemptTable.day, input.day),
        )
        .get()
        .pipe(Effect.map((row) => row ?? { known: 0, reserved: 0, charged: 0, unknown: 0 }))
    const authorize = Effect.fn("MemoryTidyStore.authorize")(function* (input: Authority) {
      if (!input.enabled) return yield* new Rejected({ reason: "unauthorized" })
      const run = yield* db
        .select()
        .from(MemoryTidyRunTable)
        .where(
          and(
            eq(MemoryTidyRunTable.session_id, input.sessionID),
            eq(MemoryTidyRunTable.scope, input.scope),
            eq(MemoryTidyRunTable.state, "active"),
          ),
        )
        .get()

      if (!run) return yield* new Rejected({ reason: "unauthorized" })
      const session = yield* db
        .select({ model: SessionTable.model })
        .from(SessionTable)
        .where(and(eq(SessionTable.id, run.session_id), eq(SessionTable.directory, run.directory)))
        .get()

      if (!session?.model || modelKey(session.model) !== modelKey(run.model))
        return yield* new Rejected({ reason: "unauthorized" })
      return run
    })
    return Service.of({
      get: (id) => get(id).pipe(Effect.orDie),
      ownsSession: (run) =>
        run.input
          ? db
              .select({ id: SessionInputTable.id })
              .from(SessionInputTable)
              .where(
                and(
                  eq(SessionInputTable.session_id, run.session_id),
                  eq(SessionInputTable.id, run.input.id),
                  eq(SessionInputTable.admitted_seq, run.input.seq),
                ),
              )
              .get()
              .pipe(
                Effect.map((row) => row !== undefined),
                Effect.orDie,
              )
          : Effect.succeed(false),
      forSession: (sessionID) =>
        db
          .select()
          .from(MemoryTidyRunTable)
          .where(eq(MemoryTidyRunTable.session_id, sessionID))
          .get()
          .pipe(Effect.orDie),
      list: (scope) =>
        db
          .select()
          .from(MemoryTidyRunTable)
          .where(eq(MemoryTidyRunTable.scope, scope))
          .orderBy(desc(MemoryTidyRunTable.time_created), desc(MemoryTidyRunTable.id))
          .all()
          .pipe(Effect.orDie),
      usage: (input) => usage(input).pipe(Effect.orDie),
      authorize: (input) => authorize(input).pipe(Effect.catchTag("EffectDrizzleQueryError", rejectSqlError)),
      guarded: (input, operation) =>
        db
          .transaction(() => authorize(input).pipe(Effect.andThen(operation)))
          .pipe(Effect.catchTags({ SqlError: rejectSqlError, EffectDrizzleQueryError: rejectSqlError })),
      create: (input, createSession) =>
        db
          .transaction(() =>
            Effect.gen(function* () {
              if (
                !input.requestID.trim() ||
                input.requestID.length > 128 ||
                !input.directory ||
                !integer(input.tokens) ||
                !integer(input.dailyTokens) ||
                input.tokens === 0 ||
                input.dailyTokens === 0
              )
                return yield* new Rejected({ reason: "invalid" })
              // Acquire the SQLite writer role before entering the trusted host
              // callback, whose Session APIs turn their SQL errors into defects.
              // This no-row write also protects a nested, deferred transaction.
              yield* db
                .update(MemoryTidyRunTable)
                .set({ state: sql`${MemoryTidyRunTable.state}` })
                .where(sql`0`)
                .run()
              const previous = yield* db
                .select()
                .from(MemoryTidyRunTable)
                .where(eq(MemoryTidyRunTable.request_id, input.requestID))
                .get()

              if (previous) {
                if (
                  previous.scope !== input.scope ||
                  previous.directory !== input.directory ||
                  modelKey(previous.model) !== modelKey(input.model) ||
                  previous.token_limit !== input.tokens ||
                  previous.daily_limit !== input.dailyTokens
                )
                  return yield* new Rejected({ reason: "conflict" })
                // An exact retry returns the same task, including its terminal state. It never restarts it.
                return previous
              }
              // The writer role serializes this check with the grant. Never
              // replay the Session-creation callback on a lock failure.
              if (
                yield* db
                  .select({ id: MemoryTidyRunTable.id })
                  .from(MemoryTidyRunTable)
                  .where(and(eq(MemoryTidyRunTable.scope, input.scope), eq(MemoryTidyRunTable.state, "active")))
                  .get()
              )
                return yield* new Rejected({ reason: "busy" })
              const id = randomUUID()
              const sessionID = SessionSchema.ID.create()
              if (
                yield* db.select({ id: SessionTable.id }).from(SessionTable).where(eq(SessionTable.id, sessionID)).get()
              )
                return yield* new Rejected({ reason: "conflict" })
              // Host callback must create without prompting/waking: both projection and grant commit together.
              const inputBinding = yield* createSession(sessionID)
              const run = yield* db
                .insert(MemoryTidyRunTable)
                .values({
                  id,
                  request_id: input.requestID,
                  session_id: sessionID,
                  input: inputBinding ?? null,
                  scope: input.scope,
                  directory: input.directory,
                  model: input.model,
                  token_limit: input.tokens,
                  daily_limit: input.dailyTokens,
                  state: "active",
                  time_created: yield* Clock.currentTimeMillis,
                })
                .returning()
                .get()

              if (!run) return yield* Effect.die("Memory tidy grant insert returned no row")
              yield* authorize({ sessionID, scope: input.scope, enabled: true })
              return run
            }),
          )
          .pipe(Effect.catchTags({ SqlError: rejectSqlError, EffectDrizzleQueryError: rejectSqlError })),
      reserve: (input) =>
        db
          .transaction(() =>
            Effect.gen(function* () {
              if (!input.attemptID || !integer(input.tokens) || input.tokens === 0)
                return yield* new Rejected({ reason: "invalid" })
              const run = yield* authorize(input)
              if (
                yield* db
                  .select({ id: MemoryTidyAttemptTable.id })
                  .from(MemoryTidyAttemptTable)
                  .where(eq(MemoryTidyAttemptTable.id, input.attemptID))
                  .get()
              )
                return yield* new Rejected({ reason: "duplicate" })
              const now = yield* Clock.currentTimeMillis
              const day = new Date(now).toISOString().slice(0, 10)
              yield* db
                .insert(MemoryTidyDayTable)
                .values({ day, token_limit: run.daily_limit })
                .onConflictDoUpdate({
                  target: MemoryTidyDayTable.day,
                  set: { token_limit: sql`min(${MemoryTidyDayTable.token_limit}, ${run.daily_limit})` },
                })
                .run()

              const limit = yield* db.select().from(MemoryTidyDayTable).where(eq(MemoryTidyDayTable.day, day)).get()

              const total = yield* usage({ runID: run.id })
              const daily = yield* usage({ day })
              if (
                !limit ||
                input.tokens > run.token_limit - total.charged ||
                input.tokens > limit.token_limit - daily.charged
              )
                return yield* new Rejected({ reason: "limit" })
              yield* db
                .insert(MemoryTidyAttemptTable)
                .values({
                  id: input.attemptID,
                  run_id: run.id,
                  day,
                  reserved: input.tokens,
                  time_created: now,
                })
                .run()
            }),
          )
          .pipe(Effect.catchTags({ SqlError: rejectSqlError, EffectDrizzleQueryError: rejectSqlError })),
      settle: (attemptID, actual) =>
        db
          .transaction(() =>
            Effect.gen(function* () {
              if (!integer(actual)) return yield* new Rejected({ reason: "invalid" })
              const attempt = yield* db
                .select()
                .from(MemoryTidyAttemptTable)
                .where(eq(MemoryTidyAttemptTable.id, attemptID))
                .get()

              if (!attempt) return yield* new Rejected({ reason: "missing" })
              if (attempt.actual !== null && attempt.actual !== actual)
                return yield* new Rejected({ reason: "conflict" })
              const exceeded = actual > attempt.reserved
              if (attempt.actual !== null) return { exceeded }
              yield* db
                .update(MemoryTidyAttemptTable)
                .set({ actual, time_settled: yield* Clock.currentTimeMillis })
                .where(eq(MemoryTidyAttemptTable.id, attemptID))
                .run()

              // Never conceal a provider report above its reservation, even after cancellation.
              if (exceeded)
                yield* db
                  .update(MemoryTidyRunTable)
                  .set({ state: "failed", time_finished: yield* Clock.currentTimeMillis })
                  .where(eq(MemoryTidyRunTable.id, attempt.run_id))
                  .run()

              return { exceeded }
            }),
          )
          .pipe(Effect.catchTags({ SqlError: rejectSqlError, EffectDrizzleQueryError: rejectSqlError })),
      finish: (id, state) =>
        db
          .transaction(() =>
            Effect.gen(function* () {
              const run = yield* get(id)
              if (!run) return yield* new Rejected({ reason: "missing" })
              if (run.state !== "active") {
                if (run.state !== state) return yield* new Rejected({ reason: "conflict" })
                return
              }
              yield* db
                .update(MemoryTidyRunTable)
                .set({ state, time_finished: yield* Clock.currentTimeMillis })
                .where(eq(MemoryTidyRunTable.id, id))
                .run()
            }),
          )
          .pipe(Effect.catchTags({ SqlError: rejectSqlError, EffectDrizzleQueryError: rejectSqlError })),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })

// A competing connection can invalidate a read snapshot before its first write.
// Reject after rollback; never replay a host callback or a guarded mutation here.
function rejectSqlError(error: SqlError | EffectDrizzleQueryError) {
  const cause = isSqlError(error) ? Cause.fail(error) : error.cause
  return Cause.isCause(cause) &&
    cause.reasons.length > 0 &&
    cause.reasons.every(
      (reason) =>
        Cause.isFailReason(reason) && isSqlError(reason.error) && reason.error.reason._tag === "LockTimeoutError",
    )
    ? Effect.fail(new Rejected({ reason: "busy" }))
    : Effect.die(error)
}
