import { Effect, Layer } from "effect"
import { LayerNode } from "@zaovra-ai/core/effect/layer-node"
import { memoMap } from "@zaovra-ai/core/effect/memo-map"
import { EventV2 } from "@zaovra-ai/core/event"
import { buildLocationServiceMap, LocationServiceMap } from "@zaovra-ai/core/location-services"
import { SessionExecution } from "@zaovra-ai/core/session/execution"
import { SessionExecutionLocal } from "@zaovra-ai/core/session/execution/local"
import { EventV2Bridge } from "@/event-v2-bridge"
import { AppNodeBuilderV1 } from "./app-node-builder-v1"

const sharedReplacements = [
  [EventV2Bridge.node, Layer.effect(EventV2Bridge.Service, EventV2Bridge.Service)],
  [LocationServiceMap.node, Layer.effect(LocationServiceMap.Service, LocationServiceMap.Service)],
  [SessionExecution.node, Layer.effect(SessionExecution.Service, SessionExecution.Service)],
  [EventV2.node, Layer.effect(EventV2.Service, EventV2Bridge.Service)],
] as const satisfies LayerNode.Replacements

/** An internal host scope. Reuse this object for HTTP and every observer of that host.
 * Replacements are trusted construction inputs, never request/config data.
 */
export function create(replacements: LayerNode.Replacements = []) {
  return make(replacements, Layer.makeMemoMapUnsafe())
}

function make(hostReplacements: LayerNode.Replacements, hostMemoMap: Layer.MemoMap) {
  function share<A, E, R>(services: Layer.Layer<A, E, R>) {
    return Layer.fromBuild((_, scope) => Layer.buildWithMemoMap(services, hostMemoMap, scope))
  }
  const locations = Layer.unwrap(
    Effect.gen(function* () {
      const events = yield* EventV2Bridge.Service
      return buildLocationServiceMap(hostReplacements.concat([[EventV2.node, Layer.succeed(EventV2.Service, events)]]))
    }),
  )
  const services = AppNodeBuilderV1.build(
    SessionExecutionLocal.node,
    hostReplacements.concat([
      [LocationServiceMap.node, Layer.effect(LocationServiceMap.Service, LocationServiceMap.Service)],
      [EventV2.node, Layer.effect(EventV2.Service, EventV2Bridge.Service)],
    ]),
  ).pipe(
    Layer.provideMerge(locations),
    Layer.provideMerge(AppNodeBuilderV1.build(EventV2Bridge.node, hostReplacements)),
  )
  return { layer: share(services), share, replacements: hostReplacements.concat(sharedReplacements) }
}

// Preserve the process-global default used by existing HTTP/TUI entrypoints.
// Custom hosts instead own their memoization, including projectors and dependencies.
const defaults = make([], memoMap)
export const layer = defaults.layer
export const share = defaults.share
export const replacements = defaults.replacements
export type Host = ReturnType<typeof create>

export * as SessionRuntime from "./session-runtime"
