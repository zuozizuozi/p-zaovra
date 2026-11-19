export * as MemoryAutomatic from "./automatic"

import { Clock, Context, Effect, Layer, Schedule } from "effect"
import { Config } from "../config"
import { Database } from "../database/database"
import { Credential } from "../credential"
import { BackgroundJob } from "../background-job"
import { makeGlobalNode } from "../effect/app-node"
import { Location } from "../location"
import { LocationServiceMap } from "../location-service-map"
import { AbsolutePath } from "../schema"
import { SessionV2 } from "../session"
import { SessionExecution } from "../session/execution"
import { MemoryAutomaticIdle } from "./automatic-idle"
import { MemoryAutomaticStore } from "./automatic-store"
import { MemoryStore } from "./store"
import { MemoryTidy } from "./tidy"
import { MemoryTidyStore } from "./tidy-store"
import { MemoryTidyTasks } from "./tidy-tasks"
import { MemoryTidyCount } from "./tidy-count"
import type { ModelV2 } from "../model"

export interface Interface {
  readonly get: (directory: string) => Effect.Effect<MemoryAutomaticStore.Preference | undefined>
  readonly countVerified: (preference: MemoryAutomaticStore.Preference) => Effect.Effect<boolean>
  readonly confirm: (
    directory: AbsolutePath,
    input: MemoryAutomaticStore.Confirmation,
    modelAvailable?: boolean,
  ) => Effect.Effect<MemoryAutomaticStore.Preference, MemoryTidyStore.Rejected>
  readonly disable: (
    directory: string,
    expected: string,
  ) => Effect.Effect<MemoryAutomaticStore.Preference, MemoryTidyStore.Rejected>
  /** Host lifecycle only. Neither reading settings nor constructing this service calls models. */
  readonly tick: Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@zaovra/MemoryAutomatic") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const automatic = yield* MemoryAutomaticStore.Service
    const { db } = yield* Database.Service
    const credentials = yield* Credential.Service
    const jobs = yield* BackgroundJob.Service
    const idle = yield* MemoryAutomaticIdle.Service
    const memory = yield* MemoryStore.Service
    const store = yield* MemoryTidyStore.Service
    const tasks = yield* MemoryTidyTasks.Service
    const sessions = yield* SessionV2.Service
    const execution = yield* SessionExecution.Service
    const locations = yield* LocationServiceMap.Service
    const context = yield* Effect.context<
      MemoryStore.Service | MemoryTidyStore.Service | MemoryTidyTasks.Service | SessionV2.Service
    >()
    const tidyLayer = MemoryTidy.layer.pipe(
      Layer.provide(
        Layer.succeedContext(
          Context.pick(
            MemoryStore.Service,
            MemoryTidyStore.Service,
            MemoryTidyTasks.Service,
            SessionV2.Service,
          )(context),
        ),
      ),
    )
    const quiet: { since?: number; revision?: string } = {}
    const verifiedBinding = Effect.fn("MemoryAutomatic.verifiedBinding")(function* (
      directory: string,
      model: ModelV2.Ref,
    ) {
      const binding = yield* MemoryTidyCount.configuredBinding(model).pipe(
        Effect.provideService(Credential.Service, credentials),
      )
      return binding && (yield* MemoryTidyCount.verified(db, directory, binding).pipe(Effect.orDie))
        ? binding
        : undefined
    })
    const cancel = Effect.fn("MemoryAutomatic.cancel")(function* (id: string | undefined) {
      if (!id) return
      const run = yield* store.get(id)
      if (!run || (run.state !== "active" && run.state !== "cancelled")) return
      if (run.state === "active") yield* store.finish(id, "cancelled")
      if (run.input && (yield* store.ownsSession(run)))
        yield* sessions.cancelPending({ sessionID: run.session_id, expected: run.input }).pipe(Effect.orDie)
    })
    const place = Effect.gen(function* () {
      const location = yield* Location.Service
      const config = yield* Config.Service
      const scope = yield* memory.scope({ project: location.project.id, directory: location.directory })
      if (
        location.workspaceID ||
        Config.latest(yield* config.entries(), "memory")?.enabled !== true ||
        !(yield* memory.canAutomate(scope))
      )
        return yield* new MemoryTidyStore.Rejected({ reason: "unauthorized" })
      return { directory: location.directory, project: location.project.id, scope }
    })
    const tick = Effect.gen(function* () {
      const preferences = yield* automatic.enabled
      if (preferences.length === 0) {
        quiet.since = undefined
        quiet.revision = undefined
        return
      }
      // A new user task wins. Revoke only an automatic task this host owns, using
      // the persisted admission identity before interrupting any Session.
      const running = yield* tasks.active
      yield* Effect.forEach(
        preferences,
        (preference) =>
          Effect.gen(function* () {
            if (!preference.current_run || !running.has(preference.current_run)) return
            const run = yield* store.get(preference.current_run)
            if (run && !(yield* idle.available(run.session_id))) yield* cancel(run.id)
          }).pipe(Effect.catchCause((cause) => Effect.logError("Automatic memory task could not yield", cause))),
        { discard: true },
      )
      if (!(yield* idle.available())) {
        quiet.since = undefined
        return
      }
      const status = execution.status ? yield* execution.status : undefined
      // A missing version cannot prove that a short drain did not occur between polls.
      if (!status) {
        quiet.since = undefined
        return
      }
      const revision = `${status.epoch}:${status.revision}`
      const now = yield* Clock.currentTimeMillis
      if (quiet.since === undefined || quiet.revision !== revision || now < quiet.since) {
        quiet.since = now
        quiet.revision = revision
        return
      }
      // A short background task can start and finish entirely between polls.
      // Its retained timestamps still invalidate the previous quiet interval.
      if (
        (yield* jobs.list()).some((job) => Math.max(job.started_at, job.completed_at ?? job.started_at) >= quiet.since!)
      ) {
        quiet.since = now
        return
      }
      if (now - quiet.since < 60_000) return
      // Admission and source marks are durable; an interrupted start is left for
      // explicit user continuation, never retried by this polling loop.
      yield* Effect.forEach(
        preferences,
        (preference) =>
          Effect.gen(function* () {
            if (!(yield* idle.available())) return
            const target = yield* place
            if (!preference.count_binding) return
            const binding = yield* verifiedBinding(target.directory, preference.model)
            if (binding !== preference.count_binding) return
            const tidy = yield* MemoryTidy.Service
            const run = yield* automatic.claim(
              target,
              preference.generation,
              idle.available(),
              (request) =>
                tidy
                  .prepare({
                    requestID: request.requestID,
                    model: request.model,
                    tokens: request.tokens,
                    dailyTokens: request.dailyTokens,
                  })
                  .pipe(Effect.map((view) => view.run)),
              binding,
            )
            if (!run) return
            quiet.since = undefined
            yield* tidy.start(run.id)
          }).pipe(
            Effect.provide(tidyLayer),
            Effect.provide(locations.get({ directory: AbsolutePath.make(preference.directory) })),
            Effect.catchCause((cause) => Effect.logError("Automatic memory task was not started", cause)),
          ),
        { discard: true },
      )
    })
    return Service.of({
      get: automatic.get,
      countVerified: (preference) =>
        preference.enabled && preference.count_binding
          ? verifiedBinding(preference.directory, preference.model).pipe(
              Effect.map((binding) => binding === preference.count_binding),
              Effect.provide(locations.get({ directory: AbsolutePath.make(preference.directory) })),
              Effect.orElseSucceed(() => false),
            )
          : Effect.succeed(false),
      confirm: (directory, input, modelAvailable = true) =>
        Effect.gen(function* () {
          const target = yield* place
          const binding = modelAvailable ? yield* verifiedBinding(target.directory, input.model) : undefined
          const result = yield* automatic.confirm(target, input, modelAvailable, binding)
          yield* cancel(result.revokedRun)
          quiet.since = undefined
          return result.preference
        }).pipe(
          Effect.provide(locations.get({ directory })),
          Effect.catch((error) =>
            error instanceof MemoryTidyStore.Rejected
              ? Effect.fail(error)
              : Effect.fail(new MemoryTidyStore.Rejected({ reason: "unauthorized" })),
          ),
        ),
      disable: (directory, expected) =>
        Effect.gen(function* () {
          const result = yield* automatic.disable(directory, expected)
          yield* cancel(result.revokedRun)
          return result.preference
        }),
      tick,
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [
    MemoryAutomaticStore.node,
    Database.node,
    Credential.node,
    BackgroundJob.node,
    MemoryAutomaticIdle.node,
    MemoryStore.node,
    MemoryTidyStore.node,
    MemoryTidyTasks.node,
    SessionV2.node,
    SessionExecution.node,
    LocationServiceMap.node,
  ],
})

export const startupNode = makeGlobalNode({
  name: "memory-automatic-scheduler",
  layer: Layer.effectDiscard(
    Effect.gen(function* () {
      const scheduler = yield* Service
      yield* scheduler.tick.pipe(
        Effect.catchCause((cause) => Effect.logError("Automatic memory check failed", cause)),
        Effect.repeat(Schedule.spaced("5 seconds")),
        Effect.forkScoped,
      )
    }),
  ),
  deps: [node],
})
