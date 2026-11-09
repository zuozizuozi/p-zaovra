import { expect, test } from "bun:test"
import { createServer } from "node:http"
import { createZaovraClient, type Config } from "@zaovra-ai/sdk/v2/client"
import { refreshSavedProviderModels } from "./saved-provider-models"
import { manualProviderModels, providerModelsPatch } from "@/components/provider-model-config"

test("766 refresh persists missing IDs, preserves saved service/overrides/capabilities and does not select another model", async () => {
  const server = createServer((request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*")
    response.setHeader("Access-Control-Allow-Headers", "*")
    if (request.method === "OPTIONS") {
      response.end()
      return
    }
    expect(request.method).toBe("GET")
    expect(request.url).toBe("/api/provider/api-gravitex-ai/models")
    response.setHeader("Content-Type", "application/json")
    response.end(
      JSON.stringify({
        location: { directory: "synthetic" },
        data: [
          { id: "auto", name: "Auto" },
          { id: "deepseek-v4.1-flash", name: "upstream-name" },
          { id: "gpt-6-luna", name: "GPT" },
        ],
      }),
    )
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("missing port")
  const before = {
    npm: "@ai-sdk/openai",
    options: { baseURL: "https://api.gravitex.ai", headers: { "X-Saved": "synthetic" } },
    whitelist: ["auto", "deepseek-v4.1-flash"],
    blacklist: ["blocked"],
    models: {
      "deepseek-v4.1-flash": {
        name: "User name",
        provider: { npm: "@ai-sdk/openai-compatible" },
        variants: {},
        tool_call: true,
      },
    },
  }
  const config: Config = { model: "other/current", provider: { "api-gravitex-ai": before } }
  const patches: Config[] = []
  try {
    await refreshSavedProviderModels({
      client: createZaovraClient({ baseUrl: `http://127.0.0.1:${address.port}` }),
      providerID: "api-gravitex-ai",
      config: () => config,
      current: () => true,
      save: async (patch) => {
        patches.push(patch)
      },
    })
    expect(patches).toHaveLength(1)
    expect(patches[0]?.model).toBeUndefined()
    const after = patches[0]?.provider?.["api-gravitex-ai"]
    expect(after?.models?.["deepseek-v4.1-flash"]).toEqual(before.models["deepseek-v4.1-flash"])
    expect(after?.models?.["gpt-6-luna"]).toEqual({ name: "GPT" })
    expect(after?.options).toEqual(before.options)
    expect(after?.blacklist).toEqual(["blocked"])
    expect(after?.whitelist).toContain("gpt-6-luna")
    expect(after?.models?.auto).toBeUndefined()
    expect(config).toEqual({ model: "other/current", provider: { "api-gravitex-ai": before } })
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test("766 failed or stale discovery does not save; manual addition needs no credential rewrite", async () => {
  const ready = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let active = true
  let writes = 0
  let fail = true
  const server = createServer(async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*")
    response.setHeader("Access-Control-Allow-Headers", "*")
    if (request.method === "OPTIONS") {
      response.end()
      return
    }
    if (fail) {
      response.writeHead(503)
      response.end("unavailable")
      return
    }
    ready.resolve()
    await release.promise
    response.setHeader("Content-Type", "application/json")
    response.end(JSON.stringify({ data: [{ id: "concrete", name: "Concrete" }], location: { directory: "synthetic" } }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("missing port")
  const input = {
    client: createZaovraClient({ baseUrl: `http://127.0.0.1:${address.port}` }),
    providerID: "saved",
    config: () => ({}),
    current: () => active,
    save: async () => {
      writes++
    },
  }
  try {
    await expect(refreshSavedProviderModels(input)).rejects.toThrow()
    fail = false
    const pending = refreshSavedProviderModels(input)
    await ready.promise
    active = false
    release.resolve()
    expect(await pending).toEqual([])
    expect(writes).toBe(0)
    const before = {
      options: { baseURL: "https://api.gravitex.ai", headers: { "X-Saved": "synthetic" } },
      models: { "deepseek-v4.1-flash": { provider: { npm: "@ai-sdk/openai-compatible" } } },
    }
    const patch = providerModelsPatch("saved", manualProviderModels("gpt-6-luna"), before)
    expect(patch.provider.saved.options).toEqual(before.options)
    expect(patch.provider.saved.models["deepseek-v4.1-flash"]).toEqual(before.models["deepseek-v4.1-flash"])
    expect(patch.provider.saved.models["gpt-6-luna"]).toEqual({ name: "gpt-6-luna" })
  } finally {
    release.resolve()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
