import { ConfigCustomization } from "@zaovra-ai/core/config/customization"
import { LocationServiceMap } from "@zaovra-ai/core/location-services"
import { PluginV2 } from "@zaovra-ai/core/plugin"
import { PluginInternal } from "@zaovra-ai/core/plugin/internal"
import { Customization } from "@zaovra-ai/schema/customization"
import { InvalidRequestError } from "@zaovra-ai/protocol/errors"
import { Effect, RcMap } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"

const mutate = <A extends { changed: boolean }, R>(effect: Effect.Effect<A, Customization.Error, R>) =>
  Effect.gen(function* () {
    const plugins = yield* PluginV2.Service
    yield* plugins.wait(PluginInternal.readyID).pipe(Effect.timeout("15 seconds"), Effect.orDie)
    const saved = yield* effect.pipe(
      Effect.mapError((error) => new InvalidRequestError({ message: error.message, kind: "customization" })),
    )
    if (!saved.changed) return HttpApiSchema.NoContent.make()
    const locations = yield* LocationServiceMap.Service
    // Borrowed active sessions keep their runtime; subsequent requests reopen the saved configuration.
    yield* Effect.forEach(yield* RcMap.keys(locations.rcMap), (ref) => locations.invalidate(ref), { discard: true })
    return HttpApiSchema.NoContent.make()
  })

export const CustomizationHandler = HttpApiBuilder.group(Api, "server.customization", (handlers) =>
  handlers
    .handle("customization.list", () => response(ConfigCustomization.list(), "catalog"))
    .handle("customization.saveMCP", (ctx) =>
      mutate(ConfigCustomization.updateMCP(ctx.params.name, ctx.payload.config)),
    )
    .handle("customization.removeMCP", (ctx) => mutate(ConfigCustomization.updateMCP(ctx.params.name, undefined)))
    .handle("customization.toggleMCP", (ctx) =>
      mutate(ConfigCustomization.toggleMCP(ctx.params.name, ctx.payload.enabled)),
    )
    .handle("customization.toggleSkill", (ctx) =>
      mutate(ConfigCustomization.toggleSkill(ctx.params.name, ctx.payload.enabled)),
    ),
)
