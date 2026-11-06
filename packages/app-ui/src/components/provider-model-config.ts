import type { Config } from "@zaovra-ai/sdk/v2/types"
import { isProviderAutoModel, primaryProviderModel } from "@/context/model-choice"
import { providerModelType, providerProtocols, type ProviderProtocol } from "@/provider-discovery"
import { parseModelKey } from "@/utils/model-key"

export function providerModelsReady(providerID: string, config: Config, available: Record<string, unknown>) {
  const ids = Object.keys(config.provider?.[providerID]?.models ?? {}).filter((id) => !isProviderAutoModel(id))
  if (!ids.some((id) => Object.hasOwn(available, id))) return false
  const selected = parseModelKey(config.model ?? "")
  if (selected?.providerID === providerID && !isProviderAutoModel(selected.modelID))
    return Object.hasOwn(available, selected.modelID)
  return true
}

export function manualProviderModels(value: string) {
  const ids = value
    .split(/[\n,]/)
    .map((id) => id.trim())
    .filter(Boolean)
  if (!ids.length || ids.some((id) => /\s/.test(id) || isProviderAutoModel(id)))
    throw new Error("providerModelsRequired")
  if (new Set(ids).size !== ids.length) throw new Error("providerModelsDuplicate")
  const models = ids.map((id) => ({ id, name: id, type: providerModelType({ id }) }))
  if (!primaryProviderModel(models)) throw new Error("providerModelsRequired")
  return models
}

export function providerModelsPatch(
  providerID: string,
  models: Array<{ id: string; name: string; type?: string }>,
  before: NonNullable<Config["provider"]>[string] | undefined,
  protocol?: ProviderProtocol,
) {
  const concrete = models.filter((model) => !isProviderAutoModel(model.id))
  const primary = primaryProviderModel(concrete)
  if (!primary) throw new Error("providerModelsRequired")
  return {
    model: providerID + "/" + primary.id,
    provider: {
      [providerID]: {
        ...before,
        ...(protocol ? { npm: providerProtocols[protocol].npm } : {}),
        whitelist: [...new Set([...(before?.whitelist ?? []), ...concrete.map((model) => model.id)])],
        models: {
          ...before?.models,
          ...Object.fromEntries(
            concrete.map((model) => [model.id, { ...before?.models?.[model.id], name: model.name }]),
          ),
        },
      },
    },
  } satisfies Config
}
