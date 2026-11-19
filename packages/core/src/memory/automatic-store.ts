export * as MemoryAutomaticStore from "./automatic-store"

import { createHash } from "node:crypto"
import { and, asc, eq, gt, isNull, sql } from "drizzle-orm"
import { Cause, Clock, Context, Effect, Layer, Schema } from "effect"
import { isSqlError, type SqlError } from "effect/unstable/sql/SqlError"
import { EffectDrizzleQueryError } from "drizzle-orm/effect-core/errors"
import type { Memory } from "@zaovra-ai/schema/memory"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import type { ModelV2 } from "../model"
import { ProjectV2 } from "../project"
import { SessionMessage } from "../session/message"
import { SessionMessageTable, SessionTable } from "../session/sql"
import { MemoryAutomaticRunTable, MemoryAutomaticSourceTable, MemoryAutomaticTable } from "./automatic.sql"
import { MemoryTidyRunTable } from "./tidy.sql"
import { MemoryTidyStore } from "./tidy-store"
import { MemoryTidyCount } from "./tidy-count"

export type Preference = typeof MemoryAutomaticTable.$inferSelect
export type Place = { directory: string; project: ProjectV2.ID; scope: Memory.Scope }
export type Confirmation = {
  requestID: string
  expected?: string
  model: ModelV2.Ref
  tokens: number
  dailyTokens: number
}

export interface Interface {
  readonly get: (directory: string) => Effect.Effect<Preference | undefined>
  readonly enabled: Effect.Effect<Preference[]>
  /** A trusted settings action; no config or model tool calls this method. */
  readonly confirm: (
    place: Place,
    input: Confirmation,
    modelAvailable?: boolean,
    countBinding?: string,
  ) => Effect.Effect<{ preference: Preference; revokedRun?: string }, MemoryTidyStore.Rejected>
  readonly disable: (
    directory: string,
    expected: string,
  ) => Effect.Effect<{ preference: Preference; revokedRun?: string }, MemoryTidyStore.Rejected>
  /** Create the durable task and mark only its triggering versions in one transaction. */
  readonly claim: (
    place: Place,
    generation: string,
    idle: Effect.Effect<boolean>,
    prepare: (input: MemoryTidyStore.Request) => Effect.Effect<MemoryTidyStore.Run, MemoryTidyStore.Rejected>,
    countBinding?: string,
  ) => Effect.Effect<MemoryTidyStore.Run | undefined, MemoryTidyStore.Rejected>
}

export class Service extends Context.Service<Service, Interface>()("@zaovra/MemoryAutomaticStore") {}

const sameModel = (left: ModelV2.Ref, right: ModelV2.Ref) =>
  left.id === right.id &&
  left.providerID === right.providerID &&
  (left.variant ?? "default") === (right.variant ?? "default")

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const db = database.db
    const get = (directory: string) =>
      db.select().from(MemoryAutomaticTable).where(eq(MemoryAutomaticTable.directory, directory)).get()
    // Serialize writers before a nested Session/Tidy admission callback runs.
    const writer = db
      .update(MemoryAutomaticTable)
      .set({ enabled: sql`${MemoryAutomaticTable.enabled}` })
      .where(sql`0`)
      .run()
    const conflict = () => new MemoryTidyStore.Rejected({ reason: "conflict" })
    // A compaction/maintenance assistant message is not a newly completed user task.
    const inputSequence = sql<number>`max(
      coalesce((select max(i.promoted_seq) from session_input i where i.session_id = ${SessionTable.id}), -1),
      coalesce((select max(m.seq) from session_message m where m.session_id = ${SessionTable.id} and m.type = 'user'), -1)
    )`

    return Service.of({
      get: (directory) => get(directory).pipe(Effect.orDie),
      enabled: db
        .select()
        .from(MemoryAutomaticTable)
        .where(eq(MemoryAutomaticTable.enabled, true))
        .all()
        .pipe(Effect.orDie),
      confirm: (place, input, modelAvailable = true, countBinding) =>
        db
          .transaction(() =>
            Effect.gen(function* () {
              if (
                !place.directory ||
                !place.scope ||
                !input.requestID.trim() ||
                input.requestID.length > 128 ||
                !input.model.id ||
                !input.model.providerID ||
                !Number.isSafeInteger(input.tokens) ||
                input.tokens <= 0 ||
                !Number.isSafeInteger(input.dailyTokens) ||
                input.dailyTokens <= 0 ||
                input.tokens > input.dailyTokens
              )
                return yield* new MemoryTidyStore.Rejected({ reason: "invalid" })
              yield* writer
              const old = yield* get(place.directory)
              if (old?.generation === input.requestID) {
                if (
                  old.scope !== place.scope ||
                  old.project_id !== place.project ||
                  !sameModel(old.model, input.model) ||
                  old.token_limit !== input.tokens ||
                  old.daily_limit !== input.dailyTokens
                )
                  return yield* conflict()
                // A late HTTP retry must never enable consent that the user disabled.
                return { preference: old }
              }
              if (old?.generation !== input.expected) return yield* conflict()
              if (!modelAvailable) return yield* new MemoryTidyStore.Rejected({ reason: "invalid" })
              if (!countBinding || !(yield* MemoryTidyCount.verified(db, place.directory, countBinding)))
                return yield* new MemoryTidyStore.Rejected({ reason: "count" })
              const preference = yield* db
                .insert(MemoryAutomaticTable)
                .values({
                  directory: place.directory,
                  scope: place.scope,
                  project_id: place.project,
                  generation: input.requestID,
                  enabled: true,
                  model: input.model,
                  token_limit: input.tokens,
                  daily_limit: input.dailyTokens,
                  current_run: null,
                  count_binding: countBinding,
                  time_confirmed: yield* Clock.currentTimeMillis,
                })
                .onConflictDoUpdate({
                  target: MemoryAutomaticTable.directory,
                  set: {
                    scope: place.scope,
                    project_id: place.project,
                    generation: input.requestID,
                    enabled: true,
                    model: input.model,
                    token_limit: input.tokens,
                    daily_limit: input.dailyTokens,
                    current_run: null,
                    count_binding: countBinding,
                    time_confirmed: yield* Clock.currentTimeMillis,
                  },
                })
                .returning()
                .get()
              if (!preference) return yield* Effect.die("Automatic memory consent insert returned no row")
              return { preference, ...(old?.current_run ? { revokedRun: old.current_run } : {}) }
            }),
          )
          .pipe(Effect.catchTags({ SqlError: rejectSqlError, EffectDrizzleQueryError: rejectSqlError })),
      disable: (directory, expected) =>
        db
          .transaction(() =>
            Effect.gen(function* () {
              yield* writer
              const old = yield* get(directory)
              if (!old || old.generation !== expected) return yield* conflict()
              const preference = yield* db
                .update(MemoryAutomaticTable)
                .set({ enabled: false })
                .where(eq(MemoryAutomaticTable.directory, directory))
                .returning()
                .get()
              if (!preference) return yield* conflict()
              return { preference, ...(old.current_run ? { revokedRun: old.current_run } : {}) }
            }),
          )
          .pipe(Effect.catchTags({ SqlError: rejectSqlError, EffectDrizzleQueryError: rejectSqlError })),
      claim: (place, generation, idle, prepare, countBinding) =>
        db
          .transaction(() =>
            Effect.gen(function* () {
              yield* writer
              const preference = yield* get(place.directory)
              if (
                !preference?.enabled ||
                preference.generation !== generation ||
                preference.scope !== place.scope ||
                preference.project_id !== place.project
              )
                return yield* new MemoryTidyStore.Rejected({ reason: "unauthorized" })
              if (
                !countBinding ||
                preference.count_binding !== countBinding ||
                !(yield* MemoryTidyCount.verified(db, place.directory, countBinding))
              )
                return undefined
              if (!(yield* idle)) return undefined
              if (preference.current_run) {
                const previous = yield* db
                  .select()
                  .from(MemoryTidyRunTable)
                  .where(eq(MemoryTidyRunTable.id, preference.current_run))
                  .get()
                // Unknown, paused, failed and cancelled attempts need explicit user intent.
                if (previous?.state !== "completed") return undefined
              }
              if (
                yield* db
                  .select({ id: MemoryTidyRunTable.id })
                  .from(MemoryTidyRunTable)
                  .where(and(eq(MemoryTidyRunTable.scope, place.scope), eq(MemoryTidyRunTable.state, "active")))
                  .get()
              )
                return undefined
              const candidates = yield* db
                .select({
                  sessionID: SessionTable.id,
                  id: SessionMessageTable.id,
                  seq: SessionMessageTable.seq,
                  inputSeq: inputSequence,
                  data: SessionMessageTable.data,
                })
                .from(SessionMessageTable)
                .innerJoin(SessionTable, eq(SessionTable.id, SessionMessageTable.session_id))
                .leftJoin(
                  MemoryAutomaticSourceTable,
                  and(
                    eq(MemoryAutomaticSourceTable.directory, place.directory),
                    eq(MemoryAutomaticSourceTable.session_id, SessionTable.id),
                  ),
                )
                .where(
                  and(
                    eq(SessionTable.project_id, place.project),
                    ...(place.project === ProjectV2.ID.global ? [eq(SessionTable.directory, place.directory)] : []),
                    isNull(SessionTable.parent_id),
                    eq(SessionMessageTable.type, "assistant"),
                    gt(SessionMessageTable.seq, sql<number>`coalesce(${MemoryAutomaticSourceTable.seq}, -1)`),
                    gt(inputSequence, sql<number>`coalesce(${MemoryAutomaticSourceTable.input_seq}, -1)`),
                    sql`${SessionMessageTable.seq} = (select max(tail.seq) from session_message tail where tail.session_id = ${SessionTable.id})`,
                    sql`json_extract(${SessionMessageTable.data}, '$.time.completed') IS NOT NULL`,
                    sql`not exists (select 1 from memory_tidy_run tidy where tidy.session_id = ${SessionTable.id})`,
                  ),
                )
                .orderBy(asc(SessionTable.time_updated), asc(SessionTable.id))
                .limit(20)
                .all()
              const sources = candidates.filter((candidate) => {
                const assistant = Schema.decodeUnknownOption(SessionMessage.Assistant)({
                  ...candidate.data,
                  id: candidate.id,
                  type: "assistant",
                })
                return assistant._tag === "Some" && assistant.value.time.completed !== undefined
              })
              if (sources.length === 0 || !(yield* idle)) return undefined
              const requestID = `auto:${createHash("sha256")
                .update(
                  JSON.stringify([
                    place.directory,
                    generation,
                    sources.map((source) => [source.sessionID, source.seq]),
                  ]),
                )
                .digest("hex")}`
              const run = yield* prepare({
                requestID,
                scope: place.scope,
                directory: place.directory,
                model: preference.model,
                tokens: preference.token_limit,
                dailyTokens: preference.daily_limit,
              })
              if (
                run.request_id !== requestID ||
                run.scope !== place.scope ||
                run.directory !== place.directory ||
                !sameModel(run.model, preference.model)
              )
                return yield* conflict()
              yield* db
                .insert(MemoryAutomaticRunTable)
                .values({ run_id: run.id, directory: place.directory, generation })
                .run()
              yield* Effect.forEach(
                sources,
                (source) =>
                  db
                    .insert(MemoryAutomaticSourceTable)
                    .values({
                      directory: place.directory,
                      session_id: source.sessionID,
                      seq: source.seq,
                      input_seq: source.inputSeq,
                    })
                    .onConflictDoUpdate({
                      target: [MemoryAutomaticSourceTable.directory, MemoryAutomaticSourceTable.session_id],
                      set: { seq: source.seq, input_seq: source.inputSeq },
                    })
                    .run(),
                { discard: true },
              )
              yield* db
                .update(MemoryAutomaticTable)
                .set({ current_run: run.id })
                .where(eq(MemoryAutomaticTable.directory, place.directory))
                .run()
              return run
            }),
          )
          .pipe(Effect.catchTags({ SqlError: rejectSqlError, EffectDrizzleQueryError: rejectSqlError })),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })

function rejectSqlError(error: SqlError | EffectDrizzleQueryError) {
  const cause = isSqlError(error) ? Cause.fail(error) : error.cause
  return Cause.isCause(cause) &&
    cause.reasons.length > 0 &&
    cause.reasons.every(
      (reason) =>
        Cause.isFailReason(reason) && isSqlError(reason.error) && reason.error.reason._tag === "LockTimeoutError",
    )
    ? Effect.fail(new MemoryTidyStore.Rejected({ reason: "busy" }))
    : Effect.die(error)
}
