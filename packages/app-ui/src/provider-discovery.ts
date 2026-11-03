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
  input: ProviderDiscoveryInput & { modelID: string },
): Promise<ProviderProtocol> {
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
      const body: unknown = await response.json()
      if (!body || typeof body !== "object" || !(protocol === "responses" ? "output" in body : "choices" in body))
        throw new Error("服务返回了无效的协议检测结果，请在高级中指定协议")
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
  url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/(?:chat\/completions|responses|messages|models)$/, "")
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
  const models = new Map<string, { id: string; name: string }>()
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
      if (
        input.kind === "google" &&
        Array.isArray(row.supportedGenerationMethods) &&
        !row.supportedGenerationMethods.includes("generateContent")
      )
        continue
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
      models.set(id, { id, name })
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
    return [...models.values()]
  }
  throw new Error("pagination")
}
