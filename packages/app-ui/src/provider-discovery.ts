import { providerModelType, type ProviderModelType } from "./provider-models"
import { readProviderPricing, parseProviderPricing } from "./provider-pricing"
export { providerModelType, providerModelTypes, nonChatModelRules, type ProviderModelType } from "./provider-models"

export type ProviderDiscoveryInput = {
  baseURL: string
  apiKey: string
  headers?: Record<string, string>
  kind?: "openai" | "anthropic" | "google"
}

export type ProviderProtocol = keyof typeof providerProtocols

export const providerProtocols = {
  responses: { label: "OpenAI / Responses", npm: "@ai-sdk/openai", baseURL: "https://api.openai.com/v1" },
  openai: {
    label: "OpenAI / Chat Completions",
    npm: "@ai-sdk/openai-compatible",
    baseURL: "https://api.openai.com/v1",
  },
  anthropic: { label: "Anthropic / Claude", npm: "@ai-sdk/anthropic", baseURL: "https://api.anthropic.com/v1" },
  google: {
    label: "Google / Gemini",
    npm: "@ai-sdk/google",
    baseURL: "https://generativelanguage.googleapis.com/v1beta",
  },
} as const

export const providerDiscoveryPresets: Record<string, { baseURL: string; kind?: ProviderDiscoveryInput["kind"] }> = {
  deepseek: { baseURL: "https://api.deepseek.com/v1" },
  openrouter: { baseURL: "https://openrouter.ai/api/v1" },
  openai: { baseURL: "https://api.openai.com/v1" },
  anthropic: { baseURL: "https://api.anthropic.com/v1", kind: "anthropic" },
  google: { baseURL: "https://generativelanguage.googleapis.com/v1beta", kind: "google" },
}

const providerEndpoint =
  /\/(?:chat\/completions|responses|messages|models|embeddings|completions|audio(?:\/[^/]+)*|images(?:\/[^/]+)*)$/i

export function providerBaseURLCorrection(value: string, kind?: ProviderProtocol) {
  if (!providerEndpoint.test(value.trim().replace(/\/+$/, ""))) return
  try {
    return providerBaseURL(value, kind)
  } catch {
    return
  }
}

export function providerServiceKey(value?: string) {
  if (!value) return ""
  try {
    return providerBaseURL(value)
  } catch {
    return value.trim().replace(/\/+$/, "")
  }
}

export function providerPresetProtocol(value: string): ProviderProtocol | undefined {
  const base = providerServiceKey(value)
  if (!URL.canParse(base)) return
  const known = Object.entries(providerDiscoveryPresets).find(
    ([, preset]) => new URL(preset.baseURL).hostname === new URL(base).hostname,
  )?.[0]
  if (known === "openai") return "responses"
  if (known === "anthropic" || known === "google") return known
  if (known === "deepseek" || known === "openrouter") return "openai"
}

export async function detectProviderProtocol(
  input: ProviderDiscoveryInput & { modelID: string; modelType?: ProviderModelType },
): Promise<ProviderProtocol> {
  const type = input.modelType ?? providerModelType({ id: input.modelID })
  if (type && type !== "chat") throw new Error(`nonChatModel:${type}`)
  const known = providerPresetProtocol(input.baseURL)
  const base = providerBaseURL(input.baseURL, known)
  if (known) return known
  if (input.apiKey.trim().startsWith("{env:")) throw new Error("请在高级中指定协议，环境变量凭据无法在连接界面自动检测")
  const headers = new Headers(input.headers)
  headers.set("Content-Type", "application/json")
  if (input.apiKey.trim() && !headers.has("Authorization"))
    headers.set("Authorization", `Bearer ${input.apiKey.trim()}`)
  const signal = AbortSignal.timeout(15000)
  for (const protocol of ["responses", "openai"] as const) {
    const response = await fetch(`${base}/${protocol === "responses" ? "responses" : "chat/completions"}`, {
      method: "POST",
      headers,
      signal,
      redirect: "error",
      credentials: "omit",
      body: JSON.stringify(
        protocol === "responses"
          ? { model: input.modelID, input: "Reply OK", max_output_tokens: 16, store: false }
          : { model: input.modelID, messages: [{ role: "user", content: "Reply OK" }], max_tokens: 1 },
      ),
    })
    if (response.ok) {
      const body: unknown = await response.json().catch(() => {
        throw new Error("invalidModelReply")
      })
      if (!body || typeof body !== "object") throw new Error("invalidModelReply")
      const parts =
        protocol === "responses"
          ? "output" in body
            ? body.output
            : undefined
          : "choices" in body
            ? body.choices
            : undefined
      if (!Array.isArray(parts)) throw new Error("invalidModelReply")
      const text = parts
        .flatMap((part: unknown): string[] => {
          if (!part || typeof part !== "object") throw new Error("invalidModelReply")
          if (protocol === "openai") {
            const message = "message" in part ? part.message : undefined
            if (!message || typeof message !== "object" || !("role" in message) || message.role !== "assistant")
              throw new Error("invalidModelReply")
            return "content" in message && typeof message.content === "string" ? [message.content] : []
          }
          if ("type" in part && part.type === "reasoning") return []
          if (
            !("type" in part) ||
            part.type !== "message" ||
            !("role" in part) ||
            part.role !== "assistant" ||
            !("content" in part) ||
            !Array.isArray(part.content)
          )
            throw new Error("invalidModelReply")
          return part.content.flatMap((content: unknown) => {
            if (
              !content ||
              typeof content !== "object" ||
              !("type" in content) ||
              content.type !== "output_text" ||
              !("text" in content) ||
              typeof content.text !== "string"
            )
              return []
            return [content.text]
          })
        })
        .join("")
        .trim()
      if (text.toLowerCase().replace(/\s+/g, " ") === "reply ok") throw new Error("echoedModelReply")
      return protocol
    }
    const body = await response.text()
    // Authentication, quota, rate limit, context and server faults must never trigger a second protocol call.
    if (
      protocol === "responses" &&
      ([404, 405, 501].includes(response.status) ||
        (response.status === 400 &&
          /responses.{0,60}(?:not supported|unsupported|not implemented)|(?:not supported|unsupported|not implemented).{0,60}responses|convert_request_failed/i.test(
            body,
          )))
    )
      continue
    if ([400, 404].includes(response.status) && providerBaseURLCorrection(input.baseURL))
      throw new Error(`endpointURL:${base}`)
    throw new Error(`协议检测失败（HTTP ${response.status}），请检查服务和模型，或在高级中指定协议`)
  }
  throw new Error("此模型的 Responses 和 Chat 接口均不可用，请检查模型名称")
}

export function providerBaseURL(value: string, kind: ProviderProtocol = "openai") {
  const input = value
    .trim()
    .replace(/^(?:url|baseURL)\s*[:=]\s*/i, "")
    .trim()
  if (!input) throw new Error("required")
  if (!input.includes("://") && /^[^/?#]*@/.test(input)) throw new Error("credentials")
  const bare = /^(?:localhost|[\w-]+(?:\.[\w-]+)+|\[[\da-f:]+\])(?::\d+)?(?:[/?#]|$)/i.test(input)
  const local = /^(?:localhost|127\.\d+\.\d+\.\d+|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(input)
  const normalized = bare ? `${local ? "http" : "https"}://${input}` : input
  if (/^[a-z][a-z\d+.-]*:/i.test(normalized) && !/^https?:/i.test(normalized)) throw new Error("protocol")
  if (!URL.canParse(normalized) || /\s|\\/.test(normalized)) throw new Error("format")
  const url = new URL(normalized)
  if (!["https:", "http:"].includes(url.protocol)) throw new Error("protocol")
  if (url.username || url.password) throw new Error("credentials")
  if (normalized.includes("?")) throw new Error("query")
  if (normalized.includes("#")) throw new Error("fragment")
  url.pathname = url.pathname.replace(/\/+$/, "")
  while (providerEndpoint.test(url.pathname)) url.pathname = url.pathname.replace(providerEndpoint, "")
  if (!url.pathname || url.pathname === "/") url.pathname = kind === "google" ? "/v1beta" : "/v1"
  return url.href.replace(/\/$/, "")
}

export function changeProviderProtocolURL(
  value: string,
  previous: keyof typeof providerProtocols,
  next: keyof typeof providerProtocols,
) {
  if (value === providerProtocols[previous].baseURL) return providerProtocols[next].baseURL
  if (!URL.canParse(value)) return value
  const url = new URL(value)
  if (!["/v1", "/v1beta"].includes(url.pathname)) return value
  url.pathname = next === "google" ? "/v1beta" : "/v1"
  return url.href.replace(/\/$/, "")
}

export async function discoverProviderModels(input: ProviderDiscoveryInput) {
  const base = providerBaseURL(input.baseURL, input.kind)
  if (input.apiKey.trim().startsWith("{env:")) throw new Error("environment")
  const headers = new Headers(input.headers)
  headers.set("Accept", "application/json")
  if (input.apiKey.trim()) {
    const header =
      input.kind === "anthropic" ? "x-api-key" : input.kind === "google" ? "x-goog-api-key" : "Authorization"
    if (!headers.has(header))
      headers.set(header, header === "Authorization" ? `Bearer ${input.apiKey.trim()}` : input.apiKey.trim())
  }
  if (input.kind === "anthropic") headers.set("anthropic-version", "2023-06-01")
  const pricing = providerPresetProtocol(base)
    ? Promise.resolve(parseProviderPricing(undefined))
    : readProviderPricing(base)
  const models = new Map<string, { id: string; name: string; type?: ProviderModelType; protocol?: ProviderProtocol }>()
  const signal = AbortSignal.timeout(15000)
  const endpoint = new URL(`${base}/models`)
  // OpenRouter's model catalog is public; listing it does not validate a key.
  if (base === providerDiscoveryPresets.openrouter.baseURL) {
    const response = await fetch(`${base}/key`, { headers, signal, redirect: "error", credentials: "omit" })
    if (!response.ok) throw new Error(`http${response.status}`)
    endpoint.pathname += "/user"
  }
  // Follow only pagination tokens on the same endpoint, never response-supplied URLs.
  for (let page = 0; page < 20; page++) {
    const response = await fetch(endpoint, { headers, signal, redirect: "error", credentials: "omit" })
    if (!response.ok) throw new Error(`http${response.status}`)
    const body: unknown = await response.json()
    if (!body || typeof body !== "object") throw new Error("invalidResponse")
    const rows = "data" in body ? body.data : "models" in body ? body.models : undefined
    if (!Array.isArray(rows)) throw new Error("invalidResponse")
    for (const row of rows) {
      if (!row || typeof row !== "object") continue
      const id =
        typeof row.id === "string"
          ? row.id.trim()
          : input.kind === "google" && typeof row.name === "string"
            ? row.name.replace(/^models\//, "").trim()
            : ""
      if (!id) continue
      const name =
        typeof row.display_name === "string"
          ? row.display_name
          : typeof row.displayName === "string"
            ? row.displayName
            : typeof row.name === "string" && input.kind !== "google"
              ? row.name
              : id
      const type = providerModelType({ id, name }, row)
      models.set(id, { id, name, ...(type ? { type } : {}) })
    }
    if (
      input.kind === "google" &&
      "nextPageToken" in body &&
      typeof body.nextPageToken === "string" &&
      body.nextPageToken
    ) {
      endpoint.searchParams.set("pageToken", body.nextPageToken)
      continue
    }
    if (
      input.kind === "anthropic" &&
      "has_more" in body &&
      body.has_more &&
      "last_id" in body &&
      typeof body.last_id === "string"
    ) {
      endpoint.searchParams.set("after_id", body.last_id)
      continue
    }
    if (!models.size) throw new Error("empty")
    const metadata = await pricing
    return [...models.values()].map((model) => {
      const details = metadata.get(model.id)
      return details ? { ...model, ...details } : model
    })
  }
  throw new Error("pagination")
}
