import { expect, test } from "bun:test"
import { Provider } from "@zaovra-ai/schema/provider"
import { ProviderModels } from "../src/provider-models"

function saved(url: string, pkg = "@ai-sdk/openai"): Provider.Info {
  return {
    ...Provider.Info.empty(Provider.ID.make("api-gravitex-ai")),
    api: { type: "aisdk", package: pkg, url },
    request: { headers: { "X-Service": "saved-header" }, body: {} },
  }
}

test("766 saved service reuses key and headers, lists both protocols' IDs without auto or generation", async () => {
  const requests: Array<{ method: string; path: string; key: string | null; header: string | null }> = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      requests.push({
        method: request.method,
        path: new URL(request.url).pathname,
        key: request.headers.get("Authorization"),
        header: request.headers.get("X-Service"),
      })
      return Response.json({
        data: [
          { id: "auto" },
          { id: "openrouter/auto:high" },
          { id: "deepseek-v4.1-flash" },
          { id: "gpt-6-luna", name: "GPT" },
          { id: "gpt-6-luna", name: "GPT" },
          { id: "has space" },
          { id: 4 },
        ],
      })
    },
  })
  try {
    const result = await ProviderModels.discover(saved(server.url.origin), { type: "key", key: "synthetic-only" })
    expect(result).toEqual([
      { id: "deepseek-v4.1-flash", name: "deepseek-v4.1-flash" },
      { id: "gpt-6-luna", name: "GPT" },
    ])
    expect(requests).toEqual([
      { method: "GET", path: "/v1/models", key: "Bearer synthetic-only", header: "saved-header" },
    ])
    expect(JSON.stringify(result)).not.toContain("synthetic-only")
  } finally {
    await server.stop(true)
  }
})

test("766 explicit authentication header wins and a configured deployment path is retained", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      expect(new URL(request.url).pathname).toBe("/deployment/v1/models")
      expect(request.headers.get("Authorization")).toBe("Custom saved")
      return Response.json({ data: [{ id: "concrete" }] })
    },
  })
  try {
    const provider = saved(server.url.origin + "/deployment/v1/chat/completions")
    await ProviderModels.discover(
      { ...provider, request: { headers: { Authorization: "Custom saved" }, body: {} } },
      { type: "key", key: "ignored-synthetic" },
    )
  } finally {
    await server.stop(true)
  }
})

for (const kind of ["anthropic", "google"])
  test("766 paginates " + kind + " on the same saved endpoint", async () => {
    const urls: string[] = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        urls.push(url.pathname + url.search)
        expect(request.headers.get(kind === "anthropic" ? "x-api-key" : "x-goog-api-key")).toBe("synthetic")
        return Response.json(
          kind === "google"
            ? {
                models: [{ name: "models/" + (url.search ? "second" : "first") }],
                ...(!url.search ? { nextPageToken: "next" } : {}),
              }
            : {
                data: [{ id: url.search ? "second" : "first" }],
                ...(!url.search ? { has_more: true, last_id: "next" } : {}),
              },
        )
      },
    })
    try {
      expect(
        await ProviderModels.discover(saved(server.url.origin, "@ai-sdk/" + kind), { type: "key", key: "synthetic" }),
      ).toEqual([
        { id: "first", name: "first" },
        { id: "second", name: "second" },
      ])
      const path = kind === "google" ? "/v1beta/models" : "/v1/models"
      expect(urls).toEqual([path, path + (kind === "google" ? "?pageToken=next" : "?after_id=next")])
    } finally {
      await server.stop(true)
    }
  })

test("766 rejects redirects, upstream errors, malformed catalogs and oversized data without copying response bodies", async () => {
  let mode = "http"
  let redirected = 0
  const target = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      redirected++
      return Response.json({ data: [] })
    },
  })
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      if (mode === "http") return new Response("synthetic secret upstream error", { status: 401 })
      if (mode === "redirect") return Response.redirect(target.url.href)
      if (mode === "large") return new Response(" ".repeat(2 * 1024 * 1024 + 1))
      return Response.json({ data: "invalid" })
    },
  })
  try {
    for (const value of ["http", "redirect", "large", "invalid"]) {
      mode = value
      const error = await ProviderModels.discover(saved(server.url.origin)).then(
        () => undefined,
        (error: unknown) => error,
      )
      expect(error).toBeInstanceOf(Error)
      expect(String(error)).not.toContain("synthetic secret")
    }
    expect(redirected).toBe(0)
    for (const url of ["file:///tmp", "https://user:pass@example.invalid", "https://example.invalid/?key=secret"])
      await expect(ProviderModels.discover(saved(url))).rejects.toThrow()
    await expect(ProviderModels.discover(saved(server.url.origin, "unsupported"))).rejects.toThrow("unsupported")
    const controller = new AbortController()
    controller.abort()
    await expect(ProviderModels.discover(saved(server.url.origin), undefined, controller.signal)).rejects.toThrow()
  } finally {
    await server.stop(true)
    await target.stop(true)
  }
})
