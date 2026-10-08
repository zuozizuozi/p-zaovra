import type { Config } from "@zaovra-ai/sdk/v2/client"
import { providerProtocols } from "../provider-discovery"

export type ProtocolProvider = NonNullable<Config["provider"]>[string]
export type ProtocolChoice = "openai" | "responses"
export const protocolChoice = (npm?: string): ProtocolChoice | undefined =>
  npm === "@ai-sdk/openai-compatible" ? "openai" : npm === "@ai-sdk/openai" ? "responses" : undefined

export function protocolEditable(provider?: ProtocolProvider) {
  return !!provider && !!protocolChoice(provider.npm) && !!Object.keys(provider.models ?? {}).length
}

// Patch only changed protocol fields. Empty npm is a write-side deletion command,
// removed by the config writer; it is never persisted or used as an SDK package.
export function protocolPatch(
  provider: ProtocolProvider,
  choice: ProtocolChoice,
  models: Record<string, string>,
  images: Record<string, boolean> = {},
  prices: Record<string, Record<"input" | "output" | "cache_read" | "cache_write", string>> = {},
) {
  const overrides: NonNullable<ProtocolProvider["models"]> = Object.fromEntries(
    Object.entries(models).flatMap(([id, value]) => {
      const before = provider.models?.[id]?.provider?.npm
      if (before && !protocolChoice(before)) return []
      const npm =
        value === "" ? "" : value === "openai" || value === "responses" ? providerProtocols[value].npm : undefined
      if (npm === undefined || npm === (before ?? "")) return []
      return [[id, { provider: { npm } }]]
    }),
  )
  for (const [id, enabled] of Object.entries(images)) {
    const model = provider.models?.[id]
    if (!model) continue
    const input = model.modalities?.input ?? ["text"]
    if (input.includes("image") === enabled) continue
    overrides[id] = {
      ...overrides[id],
      modalities: { input: enabled ? [...input, "image"] : input.filter((value) => value !== "image") },
    }
  }
  for (const [id, fields] of Object.entries(prices)) {
    const previous = provider.models?.[id]?.cost
    if (Object.entries(fields).every(([key, value]) => value === String(previous?.[key as keyof typeof fields] ?? "")))
      continue
    // Blank is unknown, never a free rate. Base input/output must be supplied together.
    if (!fields.input.trim() || !fields.output.trim()) throw new Error("price-required")
    const entries = Object.entries(fields).filter(([, value]) => value.trim() !== "")
    if (entries.some(([, value]) => !Number.isFinite(Number(value)) || Number(value) < 0))
      throw new Error("price-invalid")
    overrides[id] = {
      ...overrides[id],
      cost: {
        ...previous,
        ...Object.fromEntries(entries.map(([key, value]) => [key, Number(value)])),
        input: Number(fields.input),
        output: Number(fields.output),
      },
    }
  }
  return {
    ...(provider.npm === providerProtocols[choice].npm ? {} : { npm: providerProtocols[choice].npm }),
    ...(Object.keys(overrides).length ? { models: overrides } : {}),
  }
}
