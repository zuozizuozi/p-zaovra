export * as MemoryTidyTools from "./tidy-tools"

import { Context, Effect, Layer } from "effect"
import { Memory } from "@zaovra-ai/schema/memory"
import { Config } from "../config"
import { makeLocationNode } from "../effect/app-node"
import { Location } from "../location"
import type { SessionSchema } from "../session/schema"
import { MemoryStore } from "./store"
import { MemoryTidyStore } from "./tidy-store"

export interface Interface {
  /** Undefined means an ordinary Session; an empty set means a revoked tidy task. */
  readonly allowed: (sessionID: SessionSchema.ID) => Effect.Effect<ReadonlySet<string> | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@zaovra/MemoryTidyTools") {}

// Shells, jobs, subagents, remote tools and general writes must not escape the
// tidy task's grant or its model-request budget. memory_review checks its own
// authority again inside the write transaction.
const permitted: ReadonlySet<string> = new Set(["read", "glob", "grep", "memory_search", "memory_review"])
const denied: ReadonlySet<string> = new Set()

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const store = yield* MemoryTidyStore.Service
    const memory = yield* MemoryStore.Service
    const config = yield* Config.Service
    const location = yield* Location.Service
    return Service.of({
      allowed: Effect.fn("MemoryTidyTools.allowed")(function* (sessionID) {
        const run = yield* store.forSession(sessionID)
        if (!run) return undefined
        if (
          run.directory !== location.directory ||
          (run.scope !== Memory.Scope.user &&
            run.scope !== (yield* memory.scope({ project: location.project.id, directory: location.directory })))
        )
          return denied
        return yield* store
          .authorize({
            sessionID,
            scope: run.scope,
            enabled: Config.latest(yield* config.entries(), "memory")?.enabled !== false,
          })
          .pipe(
            Effect.as(permitted),
            Effect.catchTag("MemoryTidy.Rejected", () => Effect.succeed(denied)),
          )
      }),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [MemoryTidyStore.node, MemoryStore.node, Config.node, Location.node],
})
