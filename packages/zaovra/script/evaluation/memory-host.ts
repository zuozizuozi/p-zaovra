import { serialize, deserialize } from "node:v8"
import { Effect, Layer, Option, Schema } from "effect"
import { Catalog } from "@zaovra-ai/core/catalog"
import { Credential } from "@zaovra-ai/core/credential"
import { Location } from "@zaovra-ai/core/location"
import { LocationServiceMap } from "@zaovra-ai/core/location-services"
import { ModelV2 } from "@zaovra-ai/core/model"
import { ModelMemoryProfile } from "@zaovra-ai/core/model-memory-profile"
import { PluginInternal } from "@zaovra-ai/core/plugin/internal"
import { PluginV2 } from "@zaovra-ai/core/plugin"
import { ProviderV2 } from "@zaovra-ai/core/provider"
import { AbsolutePath } from "@zaovra-ai/core/schema"
import { SessionRuntime } from "../../src/effect/session-runtime"
import { createEvaluationMemoryProfile } from "../../../../script/evaluation/memory/model-profile"

/** Only the isolated launcher reads this private parent capability. No product route/config switch. */
export function createMemoryHost(value: string, generation: string) {
  const decoded = Schema.decodeUnknownOption(
    Schema.UnknownFromJsonString.pipe(
      Schema.decodeTo(
        Schema.Struct({
          url: Schema.String,
          key: Schema.String,
          generation: Schema.String,
          directory: Schema.String,
          model: Schema.Struct({ id: Schema.String, providerID: Schema.String }),
        }),
      ),
    ),
  )(value)
  if (Option.isNone(decoded)) throw new Error("invalid-evaluation-memory-host")
  const input = decoded.value
  const url = new URL(input.url)
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.pathname !== "/profile" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    input.generation !== generation
  )
    throw new Error("invalid-evaluation-memory-host")
  let grant: ReturnType<typeof createEvaluationMemoryProfile> | undefined
  const host = SessionRuntime.create([
    [
      ModelMemoryProfile.node,
      Layer.succeed(
        ModelMemoryProfile.Service,
        ModelMemoryProfile.Service.of({
          memoryNote: (model, variant) => grant?.profile.memoryNote(model, variant),
        }),
      ),
    ],
    // This fresh experimental profile has no external connections. Never merge credential metadata later.
    [
      Credential.node,
      Layer.succeed(
        Credential.Service,
        Credential.Service.of({
          all: () => Effect.succeed([]),
          list: () => Effect.succeed([]),
          get: () => Effect.succeed(undefined),
          create: () => Effect.die("evaluation-credentials-disabled"),
          update: () => Effect.die("evaluation-credentials-disabled"),
          remove: () => Effect.die("evaluation-credentials-disabled"),
        }),
      ),
    ],
  ])
  const initialize = Effect.gen(function* () {
    const locations = yield* LocationServiceMap.Service
    const model = yield* Effect.gen(function* () {
      const plugins = yield* PluginV2.Service
      yield* plugins.wait(PluginInternal.readyID)
      const catalog = yield* Catalog.Service
      return yield* catalog.model.get(ProviderV2.ID.make(input.model.providerID), ModelV2.ID.make(input.model.id))
    }).pipe(Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(input.directory) }))))
    if (!model) return yield* Effect.die("evaluation-model-missing")
    const response = yield* Effect.promise(() =>
      fetch(input.url, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(5000),
        headers: { authorization: `Bearer ${input.key}`, "content-type": "application/json" },
        body: JSON.stringify({ generation, snapshot: serialize(model).toString("base64") }),
      }),
    )
    if (!response.ok) return yield* Effect.die("evaluation-memory-profile-rejected")
    const decoded = Schema.decodeUnknownOption(
      Schema.Struct({
        snapshot: Schema.String,
        binding: Schema.Struct({
          baseURL: Schema.String,
          modelID: Schema.String,
          protocol: Schema.Literals(["openai-chat", "openai-responses"]),
        }),
      }),
    )(yield* Effect.promise(() => response.json()))
    if (Option.isNone(decoded) || decoded.value.snapshot.length > 60000)
      return yield* Effect.die("evaluation-memory-profile-invalid")
    const expected: unknown = deserialize(Buffer.from(decoded.value.snapshot, "base64"))
    if (!Schema.is(ModelV2.Info)(expected)) return yield* Effect.die("evaluation-memory-profile-invalid")
    grant = createEvaluationMemoryProfile({ model: expected, variant: undefined, binding: decoded.value.binding })
    if (grant.profile.memoryNote(model, undefined) !== true)
      return yield* Effect.die("evaluation-memory-profile-mismatch")
  })
  return { host, initialize, revoke: () => grant?.revoke() }
}
