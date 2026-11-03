import { expect, test } from "bun:test"
import snapshot from "../../resources/attachments/fixtures/gravitex-pricing559.json"
import { parseProviderPricing, providerPricingPaths, readProviderPricing } from "../../../app-ui/src/provider-pricing"
import { discoverProviderModels } from "@zaovra-ai/app/provider-discovery"

const parsed = parseProviderPricing(snapshot)
test("the approved Gravitex snapshot contains all 110 models", () => {
  expect(snapshot.models).toHaveLength(110)
  expect(parsed.size).toBe(110)
})
for (const row of snapshot.models)
  test(`pricing metadata: ${row.id}`, () => {
    const model = parsed.get(row.id)
    expect(model?.name).toBe(row.nick.trim())
    expect(model?.type).toBe(row.expectedType)
    expect(model?.protocol).toBe("expectedProtocol" in row ? row.expectedProtocol : undefined)
  })

test("real list-with-groups and standard new-api shapes use endpoints before an incorrect chat tag", () => {
  const row = {
    modelName: "opaque",
    modelNickName: "Friendly name",
    tagsEn: "chat",
    supportedEndpointTypesList: ["openai-speech"],
  }
  expect(parseProviderPricing({ code: 200, data: { rows: [row] } }).get("opaque")).toEqual({
    name: "Friendly name",
    type: "tts",
  })
  expect(
    parseProviderPricing({
      success: true,
      data: [{ model_name: "opaque", supported_endpoint_types: ["embeddings"] }],
    }).get("opaque")?.type,
  ).toBe("embedding")
  expect(parseProviderPricing({ data: [{ id: "ordinary-model-list-row" }] }).size).toBe(0)
})

test("discovery reads same-origin pricing variants without credentials and applies names and protocols", async () => {
  const calls: { path: string; auth: string | null; custom: string | null }[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname
      calls.push({ path, auth: request.headers.get("authorization"), custom: request.headers.get("x-private") })
      if (path === "/v1/models") return Response.json({ data: [{ id: "claude-alias" }, { id: "gpt-alias" }] })
      if (path === "/prod-api/api/pricing/list-with-groups")
        return Response.json({
          code: 200,
          data: {
            rows: [
              {
                modelName: "claude-alias",
                modelNickName: "Claude label",
                supportedEndpointTypesList: ["openai", "anthropic"],
              },
              {
                modelName: "gpt-alias",
                modelNickName: "GPT label",
                supportedEndpointTypesList: ["openai", "openai-response"],
              },
            ],
          },
        })
      return new Response(null, { status: 404 })
    },
  })
  try {
    expect(
      await discoverProviderModels({
        baseURL: server.url.href,
        apiKey: "local-only",
        headers: { "X-Private": "synthetic-only" },
      }),
    ).toEqual([
      { id: "claude-alias", name: "Claude label", type: "chat", protocol: "anthropic" },
      { id: "gpt-alias", name: "GPT label", type: "chat", protocol: "responses" },
    ])
    expect(calls.find((call) => call.path === "/v1/models")).toMatchObject({
      auth: "Bearer local-only",
      custom: "synthetic-only",
    })
    const publicCalls = calls.filter((call) => call.path !== "/v1/models")
    expect(publicCalls.map((call) => call.path).sort()).toEqual([...providerPricingPaths].sort())
    expect(publicCalls.every((call) => call.auth === null && call.custom === null)).toBe(true)
  } finally {
    server.stop(true)
  }
})

test("metadata errors, redirects and invalid bodies are ignored without following server-supplied URLs", async () => {
  const paths: string[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname
      paths.push(path)
      if (path === "/v1/models") return Response.json({ data: [{ id: "unknown-chat" }] })
      if (path === "/api/pricing") return new Response(null, { status: 302, headers: { Location: "/must-not-follow" } })
      if (path === "/api/pricing/list-with-groups") return new Response("not JSON")
      return new Response(null, { status: 503 })
    },
  })
  try {
    expect(await discoverProviderModels({ baseURL: server.url.href, apiKey: "" })).toEqual([
      { id: "unknown-chat", name: "unknown-chat" },
    ])
    expect(paths).not.toContain("/must-not-follow")
    expect(await readProviderPricing(server.url.href)).toEqual(new Map())
  } finally {
    server.stop(true)
  }
})
