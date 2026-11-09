export * as ProviderModels from "./provider-models"

import type { Provider } from "@zaovra-ai/schema/provider"
import type { Credential } from "@zaovra-ai/schema/credential"

/** Lists IDs only. Never probes generation or returns upstream bodies/credentials. */
export async function discover(provider: Provider.Info, credential?: Credential.Value, signal?: AbortSignal) {
  if (provider.disabled || provider.api.type !== "aisdk") throw new Error("unsupported")
  const kind =
    provider.api.package === "@ai-sdk/anthropic"
      ? "anthropic"
      : provider.api.package === "@ai-sdk/google"
        ? "google"
        : ["@ai-sdk/openai", "@ai-sdk/openai-compatible", "@ai-sdk/mistral"].includes(provider.api.package)
          ? "openai"
          : undefined
  if (!kind || !provider.api.url) throw new Error("unsupported")
  const endpoint = new URL(provider.api.url)
  if (
    !/^https?:$/.test(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new Error("invalidURL")
  const base = endpoint.pathname.replace(/\/+$/, "").replace(/\/(responses|chat\/completions|messages|models)$/, "")
  endpoint.pathname = (base || (kind === "google" ? "/v1beta" : "/v1")) + "/models"
  const headers = new Headers()
  const configured = provider.api.settings?.headers
  if (configured && typeof configured === "object")
    Object.entries(configured).forEach(([key, value]) => {
      if (typeof value === "string") headers.set(key, value)
    })
  Object.entries(provider.request.headers).forEach(([key, value]) => headers.set(key, value))
  headers.set("Accept", "application/json")
  const key =
    credential?.type === "key"
      ? credential.key
      : credential?.type === "oauth"
        ? credential.access
        : (provider.request.body.apiKey ?? provider.api.settings?.apiKey)
  const auth = kind === "anthropic" ? "x-api-key" : kind === "google" ? "x-goog-api-key" : "Authorization"
  if (typeof key === "string" && key.trim() && !headers.has(auth))
    headers.set(auth, auth === "Authorization" ? `Bearer ${key.trim()}` : key.trim())
  if (kind === "anthropic" && !headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01")
  const abort = AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])])
  const models = new Map<string, { id: string; name: string }>()
  if (endpoint.origin === "https://openrouter.ai" && endpoint.pathname === "/api/v1/models")
    endpoint.pathname += "/user"
  for (let page = 0; page < 20; page++) {
    const response = await fetch(endpoint, { headers, signal: abort, redirect: "error", credentials: "omit" })
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`http${response.status}`)
    }
    if (!response.body) throw new Error("invalidResponse")
    const reader = response.body.getReader()
    const chunks: Uint8Array<ArrayBuffer>[] = []
    let size = 0
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        size += chunk.value.byteLength
        if (size > 2 * 1024 * 1024) throw new Error("tooLarge")
        chunks.push(new Uint8Array(chunk.value))
      }
    } finally {
      await reader.cancel()
      reader.releaseLock()
    }
    const body: unknown = JSON.parse(await new Blob(chunks).text())
    if (!body || typeof body !== "object") throw new Error("invalidResponse")
    const rows = "data" in body ? body.data : "models" in body ? body.models : undefined
    if (!Array.isArray(rows)) throw new Error("invalidResponse")
    rows.forEach((row: unknown) => {
      if (!row || typeof row !== "object") return
      const id =
        "id" in row && typeof row.id === "string"
          ? row.id.trim()
          : kind === "google" && "name" in row && typeof row.name === "string"
            ? row.name.replace(/^models\//, "").trim()
            : ""
      if (!id || id.length > 256 || /\s/.test(id) || /(^|\/)auto(?::|$)/i.test(id)) return
      const name =
        "display_name" in row && typeof row.display_name === "string"
          ? row.display_name
          : "displayName" in row && typeof row.displayName === "string"
            ? row.displayName
            : "name" in row && typeof row.name === "string" && kind !== "google"
              ? row.name
              : id
      models.set(id, { id, name: name.slice(0, 256) })
    })
    if (models.size > 10000) throw new Error("tooLarge")
    if (kind === "google" && "nextPageToken" in body && typeof body.nextPageToken === "string" && body.nextPageToken) {
      endpoint.searchParams.set("pageToken", body.nextPageToken)
      continue
    }
    if (
      kind === "anthropic" &&
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
