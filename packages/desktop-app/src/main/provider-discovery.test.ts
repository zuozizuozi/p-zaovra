import { describe, expect, test } from "bun:test"
import { discoverProviderModels, providerBaseURL } from "@zaovra-ai/app/provider-discovery"

describe("provider discovery", () => {
  test("normalizes service and completion URLs and rejects embedded credentials", () => {
    expect(providerBaseURL(" https://api.example.com/ ")).toBe("https://api.example.com/v1")
    expect(providerBaseURL("https://api.example.com/api/v1/chat/completions/")).toBe("https://api.example.com/api/v1")
    expect(providerBaseURL("http://localhost:1234/v1/models")).toBe("http://localhost:1234/v1")
    expect(() => providerBaseURL("file:///tmp/key")).toThrow()
    expect(() => providerBaseURL("https://user:secret@example.com")).toThrow()
    expect(() => providerBaseURL("https://example.com?key=secret")).toThrow()
  })

  test("fetches models with credentials only in headers, deduplicates, and preserves IDs", async () => {
    const requests: { path: string; key: string | null; custom: string | null }[] = []
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        requests.push({
          path: new URL(request.url).pathname,
          key: request.headers.get("authorization"),
          custom: request.headers.get("x-test"),
        })
        return Response.json({
          data: [
            { id: "vendor/model-a", name: "Model A" },
            { id: "vendor/model-a", name: "Model A" },
            { id: "model-b" },
            { bad: true },
          ],
        })
      },
    })
    try {
      expect(
        await discoverProviderModels({ baseURL: server.url.href, apiKey: " test-only ", headers: { "X-Test": "yes" } }),
      ).toEqual([
        { id: "vendor/model-a", name: "Model A" },
        { id: "model-b", name: "model-b" },
      ])
      expect(requests).toEqual([{ path: "/v1/models", key: "Bearer test-only", custom: "yes" }])
    } finally {
      server.stop(true)
    }
  })

  test("does not follow redirects or expose provider response bodies in errors", async () => {
    const paths: string[] = []
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        const path = new URL(request.url).pathname
        paths.push(path)
        if (path === "/denied/models") return new Response("secret-provider-body", { status: 401 })
        if (path === "/empty/models") return Response.json({ data: [] })
        if (path === "/invalid/models") return Response.json({ message: "not models" })
        return new Response(null, { status: 302, headers: { Location: "/leaked" } })
      },
    })
    try {
      await expect(discoverProviderModels({ baseURL: `${server.url}denied`, apiKey: "test-only" })).rejects.toThrow(
        "http401",
      )
      await expect(discoverProviderModels({ baseURL: `${server.url}empty`, apiKey: "" })).rejects.toThrow("empty")
      await expect(discoverProviderModels({ baseURL: `${server.url}invalid`, apiKey: "" })).rejects.toThrow(
        "invalidResponse",
      )
      await expect(discoverProviderModels({ baseURL: server.url.href, apiKey: "test-only" })).rejects.toThrow()
      expect(paths).not.toContain("/leaked")
    } finally {
      server.stop(true)
    }
  })

  test("uses Gemini authentication, pagination and generation capability filtering", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        expect(request.headers.get("x-goog-api-key")).toBe("test-only")
        expect(request.headers.has("authorization")).toBe(false)
        if (new URL(request.url).searchParams.get("pageToken") === "next")
          return Response.json({
            models: [{ name: "models/generate-b", displayName: "B", supportedGenerationMethods: ["generateContent"] }],
          })
        return Response.json({
          models: [{ name: "models/embed", supportedGenerationMethods: ["embedContent"] }],
          nextPageToken: "next",
        })
      },
    })
    try {
      expect(await discoverProviderModels({ baseURL: server.url.href, apiKey: "test-only", kind: "google" })).toEqual([
        { id: "generate-b", name: "B" },
      ])
    } finally {
      server.stop(true)
    }
  })

  test("uses Anthropic headers and pagination", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        expect(request.headers.get("x-api-key")).toBe("test-only")
        expect(request.headers.get("anthropic-version")).toBe("2023-06-01")
        const next = new URL(request.url).searchParams.has("after_id")
        return Response.json({
          data: [{ id: next ? "model-b" : "model-a", display_name: next ? "B" : "A" }],
          has_more: !next,
          last_id: "model-a",
        })
      },
    })
    try {
      expect(
        await discoverProviderModels({ baseURL: server.url.href, apiKey: "test-only", kind: "anthropic" }),
      ).toEqual([
        { id: "model-a", name: "A" },
        { id: "model-b", name: "B" },
      ])
    } finally {
      server.stop(true)
    }
  })
})
