export * as ConfigProviderActivation from "./provider-activation"

import type { Config } from "../config"

// A saved default is explicit user intent; a catalog entry alone is not.
export function plan(entries: readonly Config.Entry[], connected: readonly string[]) {
  const files = entries.filter((entry): entry is Config.Document => entry.type === "document")
  const selected = new Map<string, Config.Document>()
  for (const file of files) {
    if (file.info.model) selected.set("default", file)
    for (const [name, agent] of Object.entries(file.info.agents ?? {}))
      if (agent.model) selected.set("agent:" + name, file)
  }
  const allow = files.findLast((file) => file.info.provider_filter?.allow !== undefined)?.info.provider_filter?.allow
  const deny = files.findLast((file) => file.info.provider_filter?.deny !== undefined)?.info.provider_filter?.deny
  const seen = new Set<string>()
  return [...selected].flatMap(([name, file]) => {
    const value = name === "default" ? file.info.model : file.info.agents?.[name.slice(6)]?.model
    if (!value || seen.has(value)) return []
    seen.add(value)
    const slash = value.indexOf("/")
    if (slash <= 0 || slash === value.length - 1) return []
    const providerID = value.slice(0, slash)
    const modelID = value.slice(slash + 1)
    if (!connected.includes(providerID) || /(^|\/)auto(?::|$)/i.test(modelID)) return []
    if ((allow !== undefined && !allow.includes(providerID)) || deny?.includes(providerID)) return []
    const configs = files.flatMap((entry) =>
      entry.info.providers?.[providerID] ? [entry.info.providers[providerID]] : [],
    )
    if (configs.findLast((config) => config.disabled !== undefined)?.disabled) return []
    if (configs.some((config) => config.models?.[modelID] !== undefined)) return []
    const modelsAllowed = configs.findLast((config) => config.filter?.allow !== undefined)?.filter?.allow
    const modelsDenied = configs.findLast((config) => config.filter?.deny !== undefined)?.filter?.deny
    if ((modelsAllowed !== undefined && !modelsAllowed.includes(modelID)) || modelsDenied?.includes(modelID)) return []
    return [{ file, index: entries.indexOf(file), providerID, modelID }]
  })
}
