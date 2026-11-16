import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createZaovraClient } from "@zaovra-ai/sdk/v2/client"
import { manualProviderModels, providerModelsPatch, providerModelsReady } from "./provider-model-config"
import { connectProviderKey, providerOperation } from "@/utils/provider-integration"
import { resolveModelKey, resolveModelSelection } from "@/context/model-choice"

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
  // This is a transport-only test. A fresh cwd keeps HappyDOM's Node HTTP shim out
  // of the native fetch/AbortSignal boundary without changing globals in the unit suite.
  const directory = await mkdtemp(path.join(tmpdir(), "zaovra-discovery707-"))
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        "test",
        "--conditions=browser",
        path.resolve(import.meta.dir, "../../test-browser/fixtures/provider-discovery707.fixture.ts"),
      ],
      { cwd: directory, stdout: "pipe", stderr: "pipe" },
    )
    try {
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      if (process.env.ZAOVRA_TEST_REPORT_DIR) {
        const report = path.join(process.env.ZAOVRA_TEST_REPORT_DIR, "provider-discovery707-" + crypto.randomUUID())
        await Promise.all([
          Bun.write(report + ".stdout.log", stdout),
          Bun.write(report + ".stderr.log", stderr),
          Bun.write(report + ".result.json", JSON.stringify({ actual_exit: exit, signal: child.signalCode })),
        ])
        console.log("PROVIDER_DISCOVERY707_FIXTURE_REPORT", report)
      }
      expect(exit, stdout + stderr).toBe(0)
      expect(stderr).not.toContain("ECONNRESET")
      console.log(stdout.trim())
    } finally {
      if (child.exitCode === null) child.kill()
      await child.exited
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 20000)
