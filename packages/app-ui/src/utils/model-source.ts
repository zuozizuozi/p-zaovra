export function modelSource(provider: { id: string; options?: Record<string, unknown> }) {
  return provider.id === "zaovra" || provider.options?.integrationID === "zaovra" ? "official" : "own"
}

export function configuredModelIDs(
  config?: { whitelist?: string[]; models?: Record<string, unknown> },
  selected?: string,
) {
  // An explicit empty allowlist intentionally disables every model.
  if (config?.whitelist !== undefined) return new Set(config.whitelist)
  return new Set([...Object.keys(config?.models ?? {}), ...(selected ? [selected] : [])])
}
