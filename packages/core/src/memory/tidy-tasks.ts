export * as MemoryTidyTasks from "./tidy-tasks"

import { Cause, Context, Effect, Exit, FiberSet, Layer } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { SessionExecution } from "../session/execution"
import { SessionStore } from "../session/store"
import { SessionInput } from "../session/input"
import { Database } from "../database/database"
import { MemoryTidyStore } from "./tidy-store"

export interface Interface {
  readonly active: Effect.Effect<ReadonlySet<string>>
  /** Explicit user intent only; constructing this service never resumes durable runs. */
  readonly start: (id: string, enabled: Effect.Effect<boolean>) => Effect.Effect<void, MemoryTidyStore.Rejected>
}

export class Service extends Context.Service<Service, Interface>()("@zaovra/MemoryTidyTasks") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const store = yield* MemoryTidyStore.Service
    const sessions = yield* SessionStore.Service
    const execution = yield* SessionExecution.Service
    const database = yield* Database.Service
    const fork = yield* FiberSet.makeRuntime<never, void, never>()
    const active = new Set<string>()

    return Service.of({
      active: Effect.sync(() => new Set(active)),
      start: (id, enabled) =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            const run = yield* store.get(id)
            if (!run) return yield* new MemoryTidyStore.Rejected({ reason: "missing" })
            if (run.state !== "active" || active.has(id)) return
            const authority = Effect.gen(function* () {
              return yield* store.authorize({ sessionID: run.session_id, scope: run.scope, enabled: yield* enabled })
            })
            yield* authority
            const session = yield* sessions.get(run.session_id)
            if (!session || session.time.archived)
              return yield* new MemoryTidyStore.Rejected({ reason: "unauthorized" })
            // Do not adopt execution started through another entry point. The normal
            // Session coordinator still owns serialization and Stop barriers.
            if (active.has(id)) return
            if ((yield* execution.active).has(run.session_id))
              return yield* new MemoryTidyStore.Rejected({ reason: "busy" })
            if (active.has(id)) return
            active.add(id)
            fork(
              Effect.gen(function* () {
                const exit = yield* execution
                  .resume(run.session_id, {
                    id: `memory-tidy:${id}`,
                    check: authority.pipe(
                      Effect.asVoid,
                      Effect.catchTag("MemoryTidy.Rejected", () => Effect.interrupt),
                    ),
                  })
                  .pipe(Effect.exit)
                // Shutdown/Stop leaves an unfinished grant paused, unless cancel has
                // already revoked it. Reopening a list must never restart provider work.
                if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) return
                const current = yield* store.get(id)
                if (current?.state !== "active") return
                const messages = yield* sessions.context(run.session_id).pipe(Effect.orDie)
                const last = messages.findLast((message) => message.type === "assistant")
                const pending = yield* SessionInput.pending(database.db, run.session_id)
                const completed =
                  Exit.isSuccess(exit) &&
                  pending.length === 0 &&
                  last?.time.completed &&
                  !last.error &&
                  last.finish === "stop"
                yield* store
                  .finish(id, completed ? "completed" : "failed")
                  .pipe(
                    Effect.catchTag("MemoryTidy.Rejected", (error) =>
                      error.reason === "conflict" ? Effect.void : Effect.die(error),
                    ),
                  )
              }).pipe(
                Effect.ensuring(Effect.sync(() => active.delete(id))),
                Effect.catchCause((cause) =>
                  Effect.logError("Memory tidy task stopped before final status was saved", cause),
                ),
                Effect.asVoid,
              ),
            )
          }),
        ),
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [MemoryTidyStore.node, SessionStore.node, SessionExecution.node, Database.node],
})
