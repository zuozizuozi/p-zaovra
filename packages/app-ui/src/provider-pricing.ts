import { providerModelType, providerModelProtocol, type ProviderModelType } from "./provider-models"
import type { ProviderProtocol } from "./provider-discovery"

export const providerPricingPaths = [
  "/api/pricing",
  "/api/pricing/list-with-groups",
  "/prod-api/api/pricing",
  "/prod-api/api/pricing/list-with-groups",
] as const

export function parseProviderPricing(body: unknown) {
  const models = new Map<string, { name: string; type: ProviderModelType; protocol?: ProviderProtocol }>()
  if (!body || typeof body !== "object") return models
  const root = body as Record<string, unknown>
  const data =
    root.data && typeof root.data === "object" && !Array.isArray(root.data)
      ? (root.data as Record<string, unknown>)
      : root
  const rows: unknown[] | undefined = Array.isArray(body)
    ? body
    : [root.models, root.data, data.rows, data.list, data.models].find(Array.isArray)
  if (!rows) return models
  for (const row of rows) {
    if (!row || typeof row !== "object") continue
    const entry = row as Record<string, unknown>
    if (
      ![
        "modelName",
        "model_name",
        "modelNickName",
        "nick",
        "endpoints",
        "supportedEndpointTypesList",
        "supported_endpoint_types",
      ].some((key) => key in entry)
    )
      continue
    const id = [entry.modelName, entry.model_name, entry.id]
      .find((value): value is string => typeof value === "string" && !!value.trim())
      ?.trim()
    if (!id) continue
    const name =
      [entry.modelNickName, entry.nick, entry.name]
        .find((value): value is string => typeof value === "string" && !!value.trim())
        ?.trim() ?? id
    const type = providerModelType({ id, name }, row) ?? "chat"
    const protocol = type === "chat" ? providerModelProtocol({ id, name }, row) : undefined
    models.set(id, { name, type, ...(protocol ? { protocol } : {}) })
  }
  return models
}

export async function readProviderPricing(baseURL: string) {
  // Public same-origin metadata never receives the model API key or custom headers.
  const origin = new URL(baseURL).origin
  const results = await Promise.all(
    providerPricingPaths.map(async (path) => {
      try {
        const response = await fetch(origin + path, {
          headers: { Accept: "application/json" },
          credentials: "omit",
          redirect: "error",
          signal: AbortSignal.timeout(1500),
        })
        return response.ok ? parseProviderPricing(await response.json()) : parseProviderPricing(undefined)
      } catch {
        return parseProviderPricing(undefined)
      }
    }),
  )
  const models: ReturnType<typeof parseProviderPricing> = new Map()
  for (const result of results) for (const [id, model] of result) if (!models.has(id)) models.set(id, model)
  return models
}
