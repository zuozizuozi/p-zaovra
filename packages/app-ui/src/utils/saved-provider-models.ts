import type { Config, ZaovraClient } from "@zaovra-ai/sdk/v2/client"
import { providerModelsPatch } from "@/components/provider-model-config"
import { providerModelType } from "@/provider-discovery"
import { isProviderAutoModel } from "@/context/model-choice"

export async function refreshSavedProviderModels(input: {
  client: ZaovraClient
  providerID: string
  config: () => Config
  save: (patch: Config) => Promise<unknown>
  current: () => boolean
  directory?: string
}) {
  if (!input.current()) return []
  const response = await input.client.v2.provider.models(
    { providerID: input.providerID, location: input.directory ? { directory: input.directory } : undefined },
    { throwOnError: true },
  )
  if (!input.current()) return []
  const models = (response.data?.data ?? [])
    .filter((model) => !isProviderAutoModel(model.id))
    .map((model) => ({ ...model, type: providerModelType(model) }))
  if (!models.length) throw new Error("providerModelsRequired")
  const before = input.config().provider?.[input.providerID]
  const patch = providerModelsPatch(input.providerID, models, before)
  // Discovery adds missing IDs. Existing names, protocol overrides and capability
  // metadata remain authoritative; a catalog refresh never selects another model.
  const changed = models.some(
    (model) => !before?.models?.[model.id] || (before.whitelist && !before.whitelist.includes(model.id)),
  )
  if (changed) await input.save({ provider: { [input.providerID]: patch.provider[input.providerID] } })
  return input.current() ? models : []
}
