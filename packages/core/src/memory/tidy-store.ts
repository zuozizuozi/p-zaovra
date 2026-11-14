export * as MemoryTidyStore from "./tidy-store"

import { randomUUID } from "node:crypto"
import { and, eq, sql } from "drizzle-orm"
import { Clock, Context, Effect, Layer, Schema } from "effect"
import type { Memory } from "@zaovra-ai/schema/memory"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import type { ModelV2 } from "../model"
import { SessionSchema } from "../session/schema"
import { SessionTable } from "../session/sql"
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
  reason: Schema.Literals(["invalid", "conflict", "unauthorized", "limit", "duplicate", "missing"]),
}) {}

export interface Interface {
  readonly create: (
    input: Request,
    createSession: (id: SessionSchema.ID) => Effect.Effect<void>,
  ) => Effect.Effect<Run, Rejected>
  readonly get: (id: string) => Effect.Effect<Run | undefined>
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
    const get = (id: string) =>
      db.select().from(MemoryTidyRunTable).where(eq(MemoryTidyRunTable.id, id)).get().pipe(Effect.orDie)
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
        .pipe(
          Effect.map((row) => row ?? { known: 0, reserved: 0, charged: 0, unknown: 0 }),
          Effect.orDie,
        )
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
        .pipe(Effect.orDie)
      if (!run) return yield* new Rejected({ reason: "unauthorized" })
      const session = yield* db
        .select({ model: SessionTable.model })
        .from(SessionTable)
        .where(and(eq(SessionTable.id, run.session_id), eq(SessionTable.directory, run.directory)))
        .get()
        .pipe(Effect.orDie)
      if (!session?.model || modelKey(session.model) !== modelKey(run.model))
        return yield* new Rejected({ reason: "unauthorized" })
      return run
    })
    return Service.of({
      get,
      usage,
      authorize,
      guarded: (input, operation) =>
        db
          .transaction(() => authorize(input).pipe(Effect.andThen(operation)))
          .pipe(Effect.catchTag("SqlError", Effect.die)),
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
              const previous = yield* db
                .select()
                .from(MemoryTidyRunTable)
                .where(eq(MemoryTidyRunTable.request_id, input.requestID))
                .get()
                .pipe(Effect.orDie)
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
              const id = randomUUID()
              const sessionID = SessionSchema.ID.create()
              if (
                yield* db
                  .select({ id: SessionTable.id })
                  .from(SessionTable)
                  .where(eq(SessionTable.id, sessionID))
                  .get()
                  .pipe(Effect.orDie)
              )
                return yield* new Rejected({ reason: "conflict" })
              // Host callback must create without prompting/waking: both projection and grant commit together.
              yield* createSession(sessionID)
              const run = yield* db
                .insert(MemoryTidyRunTable)
                .values({
                  id,
                  request_id: input.requestID,
                  session_id: sessionID,
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
                .pipe(Effect.orDie)
              if (!run) return yield* Effect.die("Memory tidy grant insert returned no row")
              yield* authorize({ sessionID, scope: input.scope, enabled: true })
              return run
            }),
          )
          .pipe(Effect.catchTag("SqlError", Effect.die)),
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
                  .pipe(Effect.orDie)
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
                .pipe(Effect.orDie)
              const limit = yield* db
                .select()
                .from(MemoryTidyDayTable)
                .where(eq(MemoryTidyDayTable.day, day))
                .get()
                .pipe(Effect.orDie)
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
                .pipe(Effect.orDie)
            }),
          )
          .pipe(Effect.catchTag("SqlError", Effect.die)),
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
                .pipe(Effect.orDie)
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
                .pipe(Effect.orDie)
              // Never conceal a provider report above its reservation, even after cancellation.
              if (exceeded)
                yield* db
                  .update(MemoryTidyRunTable)
                  .set({ state: "failed", time_finished: yield* Clock.currentTimeMillis })
                  .where(eq(MemoryTidyRunTable.id, attempt.run_id))
                  .run()
                  .pipe(Effect.orDie)
              return { exceeded }
            }),
          )
          .pipe(Effect.catchTag("SqlError", Effect.die)),
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
                .pipe(Effect.orDie)
            }),
          )
          .pipe(Effect.catchTag("SqlError", Effect.die)),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
