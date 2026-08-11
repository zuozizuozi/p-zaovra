export * as WorkExecution from "./execution"

import { Context, Effect, Layer } from "effect"
import { Work } from "@zaovra-ai/schema/work"
import { LayerNode } from "../effect/layer-node"
import { Node } from "../effect/app-node"

export interface Interface {
  readonly active: Effect.Effect<ReadonlySet<Work.GoalID>>
  readonly resume: (goalID: Work.GoalID) => Effect.Effect<void>
  readonly wake: (goalID: Work.GoalID) => Effect.Effect<void>
  readonly interrupt: (goalID: Work.GoalID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@zaovra/WorkExecution") {}

export const node = LayerNode.unbound(Service, Node.tags.values.global)

export const noopLayer = Layer.succeed(
  Service,
  Service.of({
    active: Effect.succeed(new Set()),
    resume: () => Effect.void,
    wake: () => Effect.void,
    interrupt: () => Effect.void,
  }),
)
