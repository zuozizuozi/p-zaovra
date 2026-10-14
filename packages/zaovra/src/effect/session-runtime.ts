import { Effect, Layer } from "effect"
import { LayerNode } from "@zaovra-ai/core/effect/layer-node"
import { memoMap } from "@zaovra-ai/core/effect/memo-map"
import { EventV2 } from "@zaovra-ai/core/event"
import { buildLocationServiceMap, LocationServiceMap } from "@zaovra-ai/core/location-services"
import { SessionExecution } from "@zaovra-ai/core/session/execution"
import { SessionExecutionLocal } from "@zaovra-ai/core/session/execution/local"
import { EventV2Bridge } from "@/event-v2-bridge"
import { AppNodeBuilderV1 } from "./app-node-builder-v1"

const locations = Layer.unwrap(
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    return buildLocationServiceMap([[EventV2.node, Layer.succeed(EventV2.Service, events)]])
  }),
)

const services = AppNodeBuilderV1.build(SessionExecutionLocal.node, [
  [LocationServiceMap.node, Layer.effect(LocationServiceMap.Service, LocationServiceMap.Service)],
  [EventV2.node, Layer.effect(EventV2.Service, EventV2Bridge.Service)],
]).pipe(Layer.provideMerge(locations), Layer.provideMerge(AppNodeBuilderV1.build(EventV2Bridge.node)))

// HTTP listeners intentionally have independent memo maps for fresh auth/config.
// Execution ownership and its domain services cross that boundary. Effect's
// scoped memoization keeps them alive while either entrypoint still owns them.
export const layer = share(services)

// Projectors register into the shared event bus and must have the same lifetime
// as their database dependencies, never the lifetime of one HTTP listener.
export function share<A, E, R>(services: Layer.Layer<A, E, R>) {
  return Layer.fromBuild((_, scope) => Layer.buildWithMemoMap(services, memoMap, scope))
}

export const replacements = [
  [EventV2Bridge.node, Layer.effect(EventV2Bridge.Service, EventV2Bridge.Service)],
  [LocationServiceMap.node, Layer.effect(LocationServiceMap.Service, LocationServiceMap.Service)],
  [SessionExecution.node, Layer.effect(SessionExecution.Service, SessionExecution.Service)],
  [EventV2.node, Layer.effect(EventV2.Service, EventV2Bridge.Service)],
] as const satisfies LayerNode.Replacements

export * as SessionRuntime from "./session-runtime"
