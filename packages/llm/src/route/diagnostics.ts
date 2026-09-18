import { createHash } from "node:crypto"
import { Schema } from "effect"

const encode = Schema.encodeSync(Schema.UnknownFromJsonString)
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

/** Fingerprint provider-native fields without retaining prompts, code or credentials. */
export function requestShape(body: unknown, serialized: string) {
  const digest = (value: unknown) =>
    createHash("sha256")
      .update(encode(value ?? null))
      .digest("hex")
  const fields = record(body) ? body : {}
  const history = fields.messages ?? fields.input ?? fields.contents
  const messages = Array.isArray(history) ? history : []
  return {
    bodyHash: createHash("sha256").update(serialized).digest("hex"),
    bodyBytes: Buffer.byteLength(serialized),
    systemHash: digest(
      fields.system ??
        fields.instructions ??
        fields.systemInstruction ??
        messages.filter((message) => record(message) && (message.role === "system" || message.role === "developer")),
    ),
    toolsHash: digest(fields.tools ?? fields.toolConfig),
    messageHashes: messages.map(digest),
    messageCount: messages.length,
    // Allowlist numeric output controls only; never log arbitrary extension values.
    outputLimits: Object.fromEntries(
      [
        ["max_tokens", fields.max_tokens],
        ["max_output_tokens", fields.max_output_tokens],
        ["max_completion_tokens", fields.max_completion_tokens],
        [
          "generationConfig.maxOutputTokens",
          record(fields.generationConfig) ? fields.generationConfig.maxOutputTokens : undefined,
        ],
        ["inferenceConfig.maxTokens", record(fields.inferenceConfig) ? fields.inferenceConfig.maxTokens : undefined],
      ].filter((entry) => typeof entry[1] === "number" && Number.isFinite(entry[1])),
    ),
  }
}

/** Only known numeric usage fields; arbitrary provider metadata is never logged. */
export function usageNumbers(value: unknown): Record<string, unknown> {
  if (!record(value)) return {}
  const keys = new Set([
    "openai",
    "anthropic",
    "google",
    "gemini",
    "bedrock",
    "usage",
    "usageMetadata",
    "prompt_tokens",
    "completion_tokens",
    "total_tokens",
    "prompt_cache_hit_tokens",
    "prompt_cache_miss_tokens",
    "prompt_tokens_details",
    "completion_tokens_details",
    "input_tokens_details",
    "output_tokens_details",
    "cached_tokens",
    "reasoning_tokens",
    "input_tokens",
    "output_tokens",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
    "promptTokenCount",
    "candidatesTokenCount",
    "totalTokenCount",
    "cachedContentTokenCount",
    "thoughtsTokenCount",
  ])
  return Object.fromEntries(
    Object.entries(value).flatMap<[string, unknown]>(([key, item]) => {
      if (!keys.has(key)) return []
      if (typeof item === "number" && Number.isFinite(item)) return [[key, item]]
      if (record(item)) return [[key, usageNumbers(item)]]
      return []
    }),
  )
}
