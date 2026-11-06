import { expect, test } from "bun:test"
import { createServer } from "node:http"
import { createZaovraClient } from "@zaovra-ai/sdk/v2/client"
import { manualProviderModels, providerModelsPatch, providerModelsReady } from "./provider-model-config"
import { connectProviderKey, providerOperation } from "@/utils/provider-integration"
import { resolveModelKey, resolveModelSelection } from "@/context/model-choice"
import { discoverProviderModels } from "@/provider-discovery"
import { validateCustomProvider, modelRow } from "./dialog-custom-provider-form"

const models = [
  { id: "concrete", provider: { id: "saved" } },
  { id: "other", provider: { id: "other" } },
]
const valid = (key: { providerID: string; modelID: string }) =>
  models.some((model) => model.provider.id === key.providerID && model.id === key.modelID)

test("707 configured completion checks the saved choice, not an unrelated available model", () => {
  expect(providerModelsReady("saved", {}, { concrete: {} })).toBe(false)
  const config = { provider: { saved: { models: { concrete: {}, blocked: {} } } } }
  expect(providerModelsReady("saved", config, {})).toBe(false)
  expect(providerModelsReady("saved", { ...config, model: "saved/blocked" }, { concrete: {} })).toBe(false)
  expect(providerModelsReady("saved", { ...config, model: "saved/concrete" }, { concrete: {} })).toBe(true)
  expect(providerModelsReady("saved", { ...config, model: "saved/auto:high" }, { concrete: {} })).toBe(true)
  expect(
    providerModelsReady("saved", { provider: { saved: { models: { auto: {} } } } }, { auto: {}, concrete: {} }),
  ).toBe(false)
  expect(providerModelsReady("saved", config, { unrelated: {} })).toBe(false)
})

for (const id of ["auto", "auto:high", "openrouter/auto", "openrouter/auto:max"])
  test("707 all selection sources resolve hidden " + id + " within their provider", () => {
    expect(resolveModelKey({ providerID: "saved", modelID: id }, models, valid)).toEqual({
      providerID: "saved",
      modelID: "concrete",
    })
    expect(resolveModelKey({ providerID: "absent", modelID: id }, models, valid)).toBeUndefined()
    expect(resolveModelKey({ providerID: "saved", modelID: id }, [], valid)).toBeUndefined()
  })

test("707 explicit concrete IDs stay exact and unavailable choices never change provider", () => {
  expect(resolveModelKey({ providerID: "saved", modelID: "concrete" }, models, valid)).toEqual({
    providerID: "saved",
    modelID: "concrete",
  })
  expect(resolveModelKey({ providerID: "saved", modelID: "missing" }, models, valid)).toBeUndefined()
})

for (const source of ["selected", "agent", "configured", "recent", "default", "first"] as const)
  test("707 actual selection policy handles " + source + " auto and empty catalog", () => {
    const key = { providerID: "saved", modelID: "auto:high" }
    const catalog: Array<{ id: string; models: Record<string, { id: string }> }> = [
      { id: "saved", models: { auto: { id: "auto" }, concrete: { id: "concrete" } } },
      { id: "other", models: { other: { id: "other" } } },
    ]
    const defaults: Record<string, string> = source === "default" ? { saved: "auto:high" } : {}
    const input = {
      selected: source === "selected" ? key : undefined,
      agent: source === "agent" ? key : undefined,
      configured: source === "configured" ? key : undefined,
      recent: source === "recent" ? [key] : [],
      defaults,
      providers: catalog,
      models,
      valid,
      find: (key: { providerID: string; modelID: string }) =>
        models.find((model) => model.id === key.modelID && model.provider.id === key.providerID),
    }
    expect(resolveModelSelection(input)?.id).toBe("concrete")
    expect(
      resolveModelSelection({
        ...input,
        models: models.filter((model) => model.provider.id !== "saved"),
        valid: (key) => key.providerID === "other" && valid(key),
      }),
    ).toBeUndefined()
  })

test("707 manual IDs validate concrete chat choices and preserve provider restrictions", () => {
  for (const value of ["", "auto", "openrouter/auto:high", "one\none", "has space", "text-embedding-3"])
    expect(() => manualProviderModels(value)).toThrow()
  const patch = providerModelsPatch(
    "saved",
    manualProviderModels("first\nsecond"),
    { models: { disabled: { tool_call: false } }, blacklist: ["disabled"] },
    "responses",
  )
  expect(patch.model).toBe("saved/first")
  expect(patch.provider.saved.models.disabled.tool_call).toBe(false)
  expect(patch.provider.saved.blacklist).toEqual(["disabled"])
  expect(patch.provider.saved.npm).toBe("@ai-sdk/openai")
})

for (const discover of [true, false])
  test("707 credential connection requires models, preset=" + discover, async () => {
    const writes: string[] = []
    const client = createZaovraClient({
      baseUrl: "https://synthetic.invalid",
      fetch: Object.assign(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          writes.push(new Request(input, init).method)
          return new Response(JSON.stringify({ data: {} }), { headers: { "Content-Type": "application/json" } })
        },
        { preconnect() {} },
      ),
    })
    const request = { integrationID: "saved", key: "synthetic", inputs: {} }
    await expect(connectProviderKey({ client, request, current: () => true })).rejects.toThrow("providerModelsRequired")
    expect(writes).toEqual([])
    const configured: unknown[] = []
    expect(
      await connectProviderKey({
        client,
        request,
        current: () => true,
        ...(discover
          ? { discover: async () => [{ id: "concrete", name: "Concrete" }] }
          : { models: manualProviderModels("concrete") }),
        saveModels: async (models) => {
          configured.push(models)
        },
      }),
    ).toBe(true)
    expect(configured).toHaveLength(1)
    expect(writes).toEqual(["POST"])
  })

test("707 discovery failure and closed form cannot report credential-only success", async () => {
  const operation = providerOperation()
  const pending = Promise.withResolvers<{ id: string; name: string }[]>()
  const client = createZaovraClient({
    baseUrl: "https://synthetic.invalid",
    fetch: Object.assign(
      async () => {
        throw new Error("unexpected credential write")
      },
      { preconnect() {} },
    ),
  })
  const submitted = connectProviderKey({
    client,
    request: { integrationID: "saved", key: "synthetic", inputs: {} },
    current: operation.start(),
    discover: () => pending.promise,
    saveModels: async () => {
      throw new Error("unexpected old config")
    },
  })
  operation.cancel()
  pending.resolve([{ id: "concrete", name: "Concrete" }])
  expect(await submitted).toBe(false)
  for (const reason of ["http404", "timeout", "environment"])
    await expect(
      connectProviderKey({
        client,
        request: { integrationID: "saved", key: "synthetic", inputs: {} },
        current: () => true,
        discover: async () => {
          throw new Error(reason)
        },
        saveModels: async () => {},
      }),
    ).rejects.toThrow(reason)
})

test("707 real discovery 404, timeout and environment references retain a manual configuration path without generation", async () => {
  const requests: string[] = []
  const pending = Promise.withResolvers<void>()
  let mode = "404"
  const server = createServer(async (request, response) => {
    requests.push(request.method + " " + request.url)
    response.setHeader("Access-Control-Allow-Origin", "*")
    response.setHeader("Access-Control-Allow-Headers", "*")
    response.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS")
    if (request.method === "OPTIONS") {
      response.writeHead(204)
      response.end()
      return
    }
    if (mode === "timeout" && request.url?.endsWith("/models")) await pending.promise
    response.writeHead(404)
    response.end("unsupported")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing synthetic address")
  try {
    const baseURL = `http://127.0.0.1:${address.port}/v1`
    await expect(discoverProviderModels({ baseURL, apiKey: "synthetic" })).rejects.toThrow("http404")
    mode = "timeout"
    await expect(discoverProviderModels({ baseURL, apiKey: "synthetic" })).rejects.toThrow()
    const before = requests.length
    await expect(discoverProviderModels({ baseURL, apiKey: "{env:SYNTHETIC_707_KEY}" })).rejects.toThrow("environment")
    expect(requests.length).toBe(before)
    for (const apiKey of ["synthetic", "{env:SYNTHETIC_707_KEY}"]) {
      const result = validateCustomProvider({
        form: {
          providerID: "manual",
          name: "Manual",
          baseURL,
          apiKey,
          protocol: "responses",
          models: [{ ...modelRow(), id: "concrete", name: "Concrete" }],
          headers: [],
          err: {},
        },
        t: (key) => key,
        disabledProviders: [],
        existingProviderIDs: new Set(),
      }).result
      expect(result?.config.models.concrete).toBeDefined()
      expect(result?.config.npm).toBe("@ai-sdk/openai")
      expect(result?.config.env).toEqual(apiKey.startsWith("{env:") ? ["SYNTHETIC_707_KEY"] : undefined)
    }
    expect(requests.every((request) => /^(GET|OPTIONS) /.test(request))).toBe(true)
    console.log("707 synthetic discovery requests=" + requests.length + ", generation POST=0")
  } finally {
    pending.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}, 20000)
