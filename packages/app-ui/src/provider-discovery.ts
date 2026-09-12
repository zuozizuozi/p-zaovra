export type ProviderDiscoveryInput = {
  baseURL: string
  apiKey: string
  headers?: Record<string, string>
  kind?: "openai" | "anthropic" | "google"
}

export const providerProtocols = {
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
  openai: { baseURL: "https://api.openai.com/v1" },
  anthropic: { baseURL: "https://api.anthropic.com/v1", kind: "anthropic" },
  google: { baseURL: "https://generativelanguage.googleapis.com/v1beta", kind: "google" },
}

export function providerBaseURL(value: string, kind: ProviderDiscoveryInput["kind"] = "openai") {
  const url = new URL(value.trim())
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error("invalidURL")
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
