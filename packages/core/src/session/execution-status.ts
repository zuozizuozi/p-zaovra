export * as SessionExecutionStatus from "./execution-status"

import { Context, Effect, Layer, Scope } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { SessionSchema } from "./schema"

export { Changed, Version } from "@zaovra-ai/schema/session-execution-status"

/** Read-only observers must not depend on the execution router, which itself owns Locations. */
export interface Interface {
  /** Undefined means no unique live coordinator is bound; it does not mean idle. */
  readonly active: Effect.Effect<ReadonlySet<SessionSchema.ID> | undefined>
  /** Host lifecycle binding only. Readers cannot start, stop or claim a Session. */
  readonly track: (active: Effect.Effect<ReadonlySet<SessionSchema.ID>>) => Effect.Effect<void, never, Scope.Scope>
}

export class Service extends Context.Service<Service, Interface>()("@zaovra/SessionExecutionStatus") {}

export const layer = Layer.sync(Service, () => {
  const sources = new Map<object, Effect.Effect<ReadonlySet<SessionSchema.ID>>>()
  return Service.of({
    active: Effect.suspend(() =>
      sources.size !== 1
        ? Effect.succeed(undefined)
        : [...sources.values()][0]!.pipe(Effect.map((active) => new Set(active))),
    ),
    track: (active) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const token = {}
          sources.set(token, active)
          return token
        }),
        (token) =>
          Effect.sync(() => {
            sources.delete(token)
          }),
      ).pipe(Effect.asVoid),
  })
})

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
