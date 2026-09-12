import { describe, expect, test } from "bun:test"
import { validateCustomProvider } from "./dialog-custom-provider-form"

const t = (key: string) => key

describe("validateCustomProvider", () => {
  test("defaults an omitted display name to the model ID but still requires the ID", () => {
    const form = {
      providerID: "custom-provider",
      name: "Provider",
      baseURL: "https://api.example.com/v1",
      apiKey: "",
      models: [{ row: "m0", id: " model-a ", name: " ", err: {} }],
      headers: [],
      err: {},
    }
    const input = { form, t, disabledProviders: [], existingProviderIDs: new Set<string>() }
    expect(validateCustomProvider(input).result?.config.models).toEqual({ "model-a": { name: "model-a" } })
    const missing = validateCustomProvider({ ...input, form: { ...form, models: [{ ...form.models[0], id: " " }] } })
    expect(missing.result).toBeUndefined()
    expect(missing.models[0].id).toBe("provider.custom.error.required")
  })

  test("builds trimmed config payload", () => {
    const result = validateCustomProvider({
      form: {
        providerID: "custom-provider",
        name: " Custom Provider ",
        baseURL: "https://api.example.com ",
        apiKey: " {env: CUSTOM_PROVIDER_KEY} ",
        models: [{ row: "m0", id: " model-a ", name: " Model A ", err: {} }],
        headers: [
          { row: "h0", key: " X-Test ", value: " enabled ", err: {} },
          { row: "h1", key: "", value: "", err: {} },
        ],
        err: {},
      },
      t,
      disabledProviders: [],
      existingProviderIDs: new Set(),
    })

    expect(result.result).toEqual({
      providerID: "custom-provider",
      name: "Custom Provider",
      key: undefined,
      config: {
        npm: "@ai-sdk/openai-compatible",
        name: "Custom Provider",
        env: ["CUSTOM_PROVIDER_KEY"],
        options: {
          baseURL: "https://api.example.com/v1",
          headers: {
            "X-Test": "enabled",
          },
        },
        models: {
          "model-a": { name: "Model A" },
        },
        whitelist: ["model-a"],
      },
    })
  })

  test("flags duplicate rows and allows reconnecting disabled providers", () => {
    const result = validateCustomProvider({
      form: {
        providerID: "custom-provider",
        name: "Provider",
        baseURL: "https://api.example.com",
        apiKey: "secret",
        models: [
          { row: "m0", id: "model-a", name: "Model A", err: {} },
          { row: "m1", id: "model-a", name: "Model A 2", err: {} },
        ],
        headers: [
          { row: "h0", key: "Authorization", value: "one", err: {} },
          { row: "h1", key: "authorization", value: "two", err: {} },
        ],
        err: {},
      },
      t,
      disabledProviders: ["custom-provider"],
      existingProviderIDs: new Set(["custom-provider"]),
    })

    expect(result.result).toBeUndefined()
    expect(result.err.providerID).toBeUndefined()
    expect(result.models[1]).toEqual({
      id: "provider.custom.error.duplicate",
      name: undefined,
    })
    expect(result.headers[1]).toEqual({
      key: "provider.custom.error.duplicate",
      value: undefined,
    })
  })
})

for (const [protocol, npm, version] of [
  ["openai", "@ai-sdk/openai-compatible", "v1"],
  ["anthropic", "@ai-sdk/anthropic", "v1"],
  ["google", "@ai-sdk/google", "v1beta"],
] as const) {
  test(protocol + " configuration selects its real SDK and endpoint", () => {
    const result = validateCustomProvider({
      form: {
        protocol,
        providerID: "custom",
        name: "Custom",
        baseURL: "https://proxy.example.com",
        apiKey: "test-key",
        models: [{ row: "m", id: "example", name: "Example", err: {} }],
        headers: [],
        err: {},
      },
      t,
      disabledProviders: [],
      existingProviderIDs: new Set(),
    }).result
    expect(result?.config.npm).toBe(npm)
    expect(result?.config.options.baseURL).toBe("https://proxy.example.com/" + version)
    expect(result?.config.whitelist).toEqual(["example"])
    expect(result?.config.options).not.toHaveProperty("apiKey")
  })
}
