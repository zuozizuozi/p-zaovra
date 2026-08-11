export * as WorkOrganization from "./organization"

import { Work } from "@zaovra-ai/schema/work"
import { Context, Effect, Layer } from "effect"
import { Config } from "../config"
import { makeLocationNode } from "../effect/app-node"
import { WorkRole } from "./role"

export interface Interface {
  readonly contracts: Effect.Effect<ReadonlyArray<Work.RoleContract>>
}

export class Service extends Context.Service<Service, Interface>()("@zaovra/WorkOrganization") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    return Service.of({ contracts: Effect.map(config.entries(), merge) })
  }),
)

export function merge(entries: ReadonlyArray<Config.Entry>) {
  return Array.from(
    entries
      .filter((entry): entry is Config.Document => entry.type === "document")
      .flatMap((entry) => entry.info.work?.roles ?? [])
      .reduce(
        (roles, contract) => roles.set(contract.id, contract),
        new Map(WorkRole.contracts.map((contract) => [contract.id, contract])),
      )
      .values(),
  )
}

export const node = makeLocationNode({ service: Service, layer, deps: [Config.node] })
