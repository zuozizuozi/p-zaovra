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
export function protocolPatch(provider: ProtocolProvider, choice: ProtocolChoice, models: Record<string, string>) {
  const overrides = Object.fromEntries(
    Object.entries(models).flatMap(([id, value]) => {
      const before = provider.models?.[id]?.provider?.npm
      if (before && !protocolChoice(before)) return []
      const npm =
        value === "" ? "" : value === "openai" || value === "responses" ? providerProtocols[value].npm : undefined
      if (npm === undefined || npm === (before ?? "")) return []
      return [[id, { provider: { npm } }]]
    }),
  )
  return {
    ...(provider.npm === providerProtocols[choice].npm ? {} : { npm: providerProtocols[choice].npm }),
    ...(Object.keys(overrides).length ? { models: overrides } : {}),
  }
}
