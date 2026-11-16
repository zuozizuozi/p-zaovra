export * as WatcherSignal from "./watcher-signal"

import { Context, Effect, Layer, Scope } from "effect"
import { makeLocationNode } from "../effect/app-node"

type Listener = (files?: ReadonlyArray<string>) => Effect.Effect<void>

/** Location-local hints. Undefined means coverage was lost or all bindings may have changed. */
export class Service extends Context.Service<
  Service,
  {
    readonly publish: Listener
    readonly listen: (listener: Listener) => Effect.Effect<void, never, Scope.Scope>
  }
>()("@zaovra/WatcherSignal") {}

export const layer = Layer.effect(
  Service,
  Effect.sync(() => {
    const listeners = new Set<Listener>()
    return Service.of({
      publish: (files) => Effect.forEach([...listeners], (listener) => listener(files)).pipe(Effect.asVoid),
      listen: (listener) =>
        Effect.gen(function* () {
          listeners.add(listener)
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              listeners.delete(listener)
            }),
          )
        }),
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [] })
