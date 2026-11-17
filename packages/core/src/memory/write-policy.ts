export * as MemoryWritePolicy from "./write-policy"

import { Context, Effect, Layer } from "effect"
import { Catalog } from "../catalog"
import { Config } from "../config"
import { makeLocationNode } from "../effect/app-node"
import { Location } from "../location"
import { ModelMemoryProfile } from "../model-memory-profile"
import type { ModelV2 } from "../model"
import type { SessionSchema } from "../session/schema"
import { SessionStore } from "../session/store"

export interface Interface {
  readonly allowed: (sessionID: SessionSchema.ID, author?: ModelV2.Ref) => Effect.Effect<boolean>
}
export class Service extends Context.Service<Service, Interface>()("@zaovra/MemoryWritePolicy") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const catalog = yield* Catalog.Service
    const profiles = yield* ModelMemoryProfile.Service
    const sessions = yield* SessionStore.Service
    const location = yield* Location.Service
    return Service.of({
      allowed: (sessionID, author) =>
        Effect.gen(function* () {
          const entries = yield* config.entries()
          if (Config.latest(entries, "memory")?.enabled !== true) return false
          const session = yield* sessions.get(sessionID)
          if (
            !session ||
            session.parentID ||
            !session.model ||
            session.location.directory !== location.directory ||
            session.location.workspaceID !== location.workspaceID
          )
            return false
          if (
            author &&
            (author.id !== session.model.id ||
              author.providerID !== session.model.providerID ||
              (author.variant ?? "default") !== (session.model.variant ?? "default"))
          )
            return false
          const model = yield* catalog.model.get(session.model.providerID, session.model.id)
          if (!model?.enabled || !model.capabilities.tools || model.memoryNote === "off") return false
          const override = entries
            .filter((entry): entry is Config.Document => entry.type === "document")
            .map((entry) => entry.info.providers?.[session.model!.providerID]?.models?.[session.model!.id]?.memoryNote)
            .findLast((value) => value !== undefined)
          if (override === "off") return false
          if (!(yield* catalog.provider.available()).some((provider) => provider.id === model.providerID)) return false
          const variant =
            session.model.variant === undefined || session.model.variant === "default"
              ? model.request.variant
              : session.model.variant
          // Read the host profile again, not a caller's capability flag. A profile
          // must account for the resolved endpoint/request and the effective variant.
          return profiles.memoryNote(model, variant) === true
        }),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Config.node, Catalog.node, ModelMemoryProfile.node, SessionStore.node, Location.node],
})
