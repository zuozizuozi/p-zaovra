import { expect, test } from "bun:test"
import { protocolChoice, protocolEditable, protocolPatch } from "./provider-protocol"
import { validateCustomProvider } from "./dialog-custom-provider-form"

test("new Responses providers and mixed models use the existing npm fields", () => {
  const result = validateCustomProvider({
    t: (key) => key,
    disabledProviders: [],
    existingProviderIDs: new Set(),
    form: {
      protocol: "responses",
      providerID: "gateway",
      name: "Gateway",
      baseURL: "https://gateway.test/openai",
      apiKey: "",
      headers: [],
      err: {},
      models: [
        { row: "1", id: "a", name: "", err: {} },
        { row: "2", id: "b", name: "", err: {}, protocol: "openai" },
      ],
    },
  }).result!
  expect(result.config.npm).toBe("@ai-sdk/openai")
  expect(result.config.options.baseURL).toBe("https://gateway.test/openai")
  expect(result.config.models.a).toEqual({ name: "a" })
  expect(result.config.models.b).toEqual({ name: "b", provider: { npm: "@ai-sdk/openai-compatible" } })
})

test("protocol edits patch only changed fields and leave unknown SDKs untouched", () => {
  const provider = {
    npm: "@ai-sdk/openai-compatible",
    options: { baseURL: "https://gateway.test/v1", apiKey: "fixture" },
    whitelist: ["a", "b"],
    models: {
      a: { provider: { npm: "@ai-sdk/openai", api: "https://special.test/v1" }, options: { custom: true } },
      b: { provider: { npm: "private-sdk" } },
      c: {},
    },
  }
  const before = JSON.stringify(provider)
  expect(protocolEditable(provider)).toBe(true)
  expect(protocolChoice("private-sdk")).toBeUndefined()
  expect(protocolEditable({ ...provider, npm: "private-sdk" })).toBe(false)
  expect(protocolPatch(provider, "responses", { a: "", b: "", c: "openai" })).toEqual({
    npm: "@ai-sdk/openai",
    models: { a: { provider: { npm: "" } }, c: { provider: { npm: "@ai-sdk/openai-compatible" } } },
  })
  expect(protocolPatch(provider, "openai", { a: "responses", b: "", c: "" })).toEqual({})
  expect(JSON.stringify(provider)).toBe(before)
})

test("image capability edits patch only input modalities and preserve other capabilities", () => {
  const provider = {
    npm: "@ai-sdk/openai",
    models: {
      a: {
        modalities: { input: ["text", "audio"] as ("text" | "audio" | "image")[], output: ["text"] as "text"[] },
        tool_call: true,
      },
      b: { modalities: { input: ["text", "image", "pdf"] as ("text" | "image" | "pdf")[] } },
      c: {},
    },
  }
  const before = JSON.stringify(provider)
  expect(protocolPatch(provider, "responses", {}, { a: true, b: false, c: true })).toEqual({
    models: {
      a: { modalities: { input: ["text", "audio", "image"] } },
      b: { modalities: { input: ["text", "pdf"] } },
      c: { modalities: { input: ["text", "image"] } },
    },
  })
  expect(protocolPatch(provider, "responses", {}, { a: false, b: true, c: false })).toEqual({})
  expect(protocolPatch(provider, "responses", { a: "openai" }, { a: true })).toEqual({
    models: {
      a: { provider: { npm: "@ai-sdk/openai-compatible" }, modalities: { input: ["text", "audio", "image"] } },
    },
  })
  expect(JSON.stringify(provider)).toBe(before)
})
