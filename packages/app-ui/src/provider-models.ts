import type { ProviderProtocol } from "./provider-discovery"

// Match task names as tokens, not substrings such as "sd" inside a chat model's name.
export const nonChatModelRules = [
  {
    type: "asr",
    pattern: /(?:^|[^a-z0-9])(?:asr|whisper|transcrib[a-z]*|transcript[a-z]*|speech[-_ ]to[-_ ]text)(?:$|[^a-z0-9])/i,
  },
  { type: "tts", pattern: /(?:^|[^a-z0-9])(?:tts|speech|text[-_ ]to[-_ ]speech)(?:$|[^a-z0-9])/i },
  { type: "embedding", pattern: /(?:^|[^a-z0-9])(?:embed(?:ding)?s?|rerank(?:er|ing)?)(?:$|[^a-z0-9])/i },
  {
    type: "image",
    pattern:
      /(?:^|[^a-z0-9])(?:images?|seedream|nano[-_ ]banana|dall[-_ ]?e|sd[0-9.]*|sdxl|stable[-_ ]diffusion)(?:$|[^a-z0-9])/i,
  },
  {
    type: "video",
    pattern: /(?:^|[^a-z0-9])(?:seedance|veo[0-9.]*|wan[^\s/]*[-_](?:t2v|i2v|r2v|videoedit)|video)(?:$|[^a-z0-9])/i,
  },
] as const

export type ProviderModelType = "chat" | "audio" | (typeof nonChatModelRules)[number]["type"]
export const providerModelTypes: ProviderModelType[] = ["chat", "asr", "tts", "image", "video", "embedding", "audio"]

export function providerModelEndpoints(metadata?: unknown) {
  if (!metadata || typeof metadata !== "object") return []
  const data = metadata as Record<string, unknown>
  const values = data.supportedEndpointTypesList ?? data.supported_endpoint_types ?? data.endpoints
  return Array.isArray(values)
    ? values.filter((value): value is string => typeof value === "string").map((value) => value.toLowerCase())
    : []
}

export function providerModelProtocol(
  model: { id: string; name?: string },
  metadata?: unknown,
): ProviderProtocol | undefined {
  const endpoints = providerModelEndpoints(metadata)
  if (/claude|anthropic/i.test(`${model.id} ${model.name ?? ""}`) && endpoints.includes("anthropic")) return "anthropic"
  if (endpoints.includes("openai-response")) return "responses"
  if (endpoints.includes("openai")) return "openai"
  if (endpoints.includes("gemini")) return "google"
  if (endpoints.includes("anthropic")) return "anthropic"
}

export function providerModelType(model: { id: string; name?: string }, metadata?: unknown) {
  const endpoints = providerModelEndpoints(metadata)
  if (endpoints.some((value) => /asr|whisper|transcri/.test(value))) return "asr"
  if (endpoints.some((value) => /speech|tts/.test(value))) return "tts"
  if (endpoints.some((value) => /video/.test(value))) return "video"
  if (endpoints.some((value) => /image/.test(value))) return "image"
  if (endpoints.some((value) => /embed|rerank/.test(value))) return "embedding"
  if (endpoints.includes("openai-realtime")) return "audio"
  const named = nonChatModelRules.find((rule) => rule.pattern.test(`${model.id} ${model.name ?? ""}`))
  if (named) return named.type
  if (!metadata || typeof metadata !== "object") return
  const data = metadata as Record<string, unknown>
  if (
    Array.isArray(data.supportedGenerationMethods) &&
    data.supportedGenerationMethods.some((method) => method === "embedContent" || method === "batchEmbedContents")
  )
    return "embedding"
  const capabilities = data.capabilities
  if (
    (Array.isArray(capabilities) && capabilities.includes("chat")) ||
    (capabilities && typeof capabilities === "object" && "chat" in capabilities && capabilities.chat === true)
  )
    return
  const nested = data.metadata && typeof data.metadata === "object" ? (data.metadata as Record<string, unknown>) : {}
  // Input modalities and descriptions can mention images/audio on a valid multimodal chat model.
  const purpose = [data, nested]
    .flatMap((row) =>
      [row.type, row.task, row.category, row.pipeline_tag, row.purpose, row.capabilities].flatMap((value) =>
        typeof value === "string"
          ? [value]
          : Array.isArray(value)
            ? value.filter((item): item is string => typeof item === "string")
            : [],
      ),
    )
    .join(" ")
  return nonChatModelRules.find((rule) => rule.pattern.test(purpose))?.type
}
