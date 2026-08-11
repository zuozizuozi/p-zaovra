import { LayerNode } from "@zaovra-ai/core/effect/layer-node"
import { ProviderV2 } from "@zaovra-ai/core/provider"
import { ModelV2 } from "@zaovra-ai/core/model"
import { Provider } from "@/provider/provider"
import { Context, Effect, Layer, SynchronizedRef } from "effect"
import type { CommandView } from "@zaovra-ai/sdk/v2"
import { UnsupportedOperationError, type Error } from "./error"

export type ModelOption = {
  readonly providerID: ProviderV2.ID
  readonly providerName: string
  readonly modelID: ModelV2.ID
  readonly modelName: string
}

export type ModeOption = {
  readonly id: string
  readonly name: string
  readonly description?: string
}

export type ModelVariants = NonNullable<Provider.Model["variants"]>

export type DefaultModel = {
  readonly providerID: ProviderV2.ID
  readonly modelID: ModelV2.ID
}

export type Snapshot = {
  readonly directory: string
  readonly providers: Record<ProviderV2.ID, Provider.Info>
  readonly modelOptions: readonly ModelOption[]
  readonly variantsByModel: Readonly<Record<string, ModelVariants>>
  readonly availableModes: readonly ModeOption[]
  readonly defaultModeID: string
  readonly availableCommands: readonly CommandView[]
  readonly defaultModel?: DefaultModel
}

export interface LoaderInterface {
  readonly load: (directory: string) => Effect.Effect<Snapshot, Error>
}

export interface Interface {
  readonly get: (directory: string) => Effect.Effect<Snapshot, Error>
  readonly refresh: (directory: string) => Effect.Effect<Snapshot, Error>
  readonly variants: (snapshot: Snapshot, model: DefaultModel) => ModelVariants | undefined
}

export class Loader extends Context.Service<Loader, LoaderInterface>()("@zaovra/ACPDirectoryLoader") {}

export class Service extends Context.Service<Service, Interface>()("@zaovra/ACPDirectory") {}

export const modelKey = (model: DefaultModel) => `${model.providerID}/${model.modelID}`

export const variants = (snapshot: Snapshot, model: DefaultModel) => snapshot.variantsByModel[modelKey(model)]

export const build = (input: {
  readonly directory: string
  readonly providers: Record<ProviderV2.ID, Provider.Info>
  readonly modes: readonly ModeOption[]
  readonly defaultModeID: string
  readonly commands: readonly CommandView[]
  readonly defaultModel?: DefaultModel
}): Snapshot => {
  const modelOptions = Provider.sort(
    Object.values(input.providers).flatMap((provider) =>
      Object.values(provider.models).map((model) => ({
        id: model.id,
        providerID: provider.id,
        providerName: provider.name,
        modelID: model.id,
        modelName: model.name,
      })),
    ),
  ).map((model) => ({
    providerID: model.providerID,
    providerName: model.providerName,
    modelID: model.modelID,
    modelName: model.modelName,
  }))

  return {
    directory: input.directory,
    providers: input.providers,
    modelOptions,
    variantsByModel: Object.fromEntries(
      Object.values(input.providers).flatMap((provider) =>
        Object.values(provider.models).flatMap((model) =>
          model.variants ? [[modelKey({ providerID: provider.id, modelID: model.id }), model.variants]] : [],
        ),
      ),
    ),
    availableModes: input.modes,
    defaultModeID: input.modes.some((mode) => mode.id === input.defaultModeID)
      ? input.defaultModeID
      : (input.modes[0]?.id ?? input.defaultModeID),
    availableCommands: input.commands,
    ...(input.defaultModel ? { defaultModel: input.defaultModel } : {}),
  }
}

export const loaderLayer = Layer.effect(
  Loader,
  Effect.succeed(
    Loader.of({
      load: (directory) =>
        Effect.fail(new UnsupportedOperationError({ method: `ACP directory load without V2 client: ${directory}` })),
    }),
  ),
)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const loader = yield* Loader
    const snapshots = yield* SynchronizedRef.make(new Map<string, Effect.Effect<Snapshot, Error>>())

    const cached = Effect.fnUntraced(function* (directory: string) {
      return yield* SynchronizedRef.modifyEffect(
        snapshots,
        Effect.fnUntraced(function* (items) {
          const current = items.get(directory)
          if (current) return [current, items] as const
          const next = yield* Effect.cached(
            loader.load(directory).pipe(
              Effect.tapError(() =>
                SynchronizedRef.update(snapshots, (state) => {
                  const next = new Map(state)
                  next.delete(directory)
                  return next
                }),
              ),
            ),
          )
          return [next, new Map(items).set(directory, next)] as const
        }),
      )
    })

    const get = Effect.fn("ACPDirectory.get")(function* (directory: string) {
      return yield* yield* cached(directory)
    })

    const refresh = Effect.fn("ACPDirectory.refresh")(function* (directory: string) {
      return yield* SynchronizedRef.modifyEffect(
        snapshots,
        Effect.fnUntraced(function* (items) {
          const next = yield* Effect.cached(
            loader.load(directory).pipe(
              Effect.tapError(() =>
                SynchronizedRef.update(snapshots, (state) => {
                  const next = new Map(state)
                  next.delete(directory)
                  return next
                }),
              ),
            ),
          )
          return [next, new Map(items).set(directory, next)] as const
        }),
      ).pipe(Effect.flatten)
    })

    return Service.of({
      get,
      refresh,
      variants,
    })
  }),
)

export const loaderNode = LayerNode.make({
  service: Loader,
  layer: loaderLayer,
  deps: [],
})

export const node = LayerNode.make({ service: Service, layer, deps: [loaderNode] })

export * as Directory from "./directory"
