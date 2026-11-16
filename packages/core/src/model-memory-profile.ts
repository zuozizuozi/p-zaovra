export * as ModelMemoryProfile from "./model-memory-profile"

import { Context, Layer } from "effect"
import { makeGlobalNode } from "./effect/app-node"
import type { ModelV2 } from "./model"

/** Host-owned evaluation results, deliberately absent from PluginContext and config. */
export interface Interface {
  readonly memoryNote: (model: ModelV2.Info, variant: string | undefined) => boolean | undefined
}
export class Service extends Context.Service<Service, Interface>()("@zaovra/ModelMemoryProfile") {}

// No real model has an admitted evaluation profile yet. Tool transport support,
// model names and third-party catalog declarations cannot establish reliability.
export const layer = Layer.succeed(Service, Service.of({ memoryNote: () => undefined }))
export const node = makeGlobalNode({ service: Service, layer, deps: [] })
