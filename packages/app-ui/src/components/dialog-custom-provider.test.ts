import { describe, expect, test } from "bun:test"
import { validateCustomProvider, validateProviderURL } from "./dialog-custom-provider-form"
import { providerBaseURL } from "../provider-discovery"

const t = (key: string) => key

test("discovery and saving share address normalization and rejection reasons", () => {
  for (const [input, output] of [
    ["api.example.com", "https://api.example.com/v1"],
    ["localhost:11434", "http://localhost:11434/v1"],
    ["127.0.0.1:8080", "http://127.0.0.1:8080/v1"],
    ["[::1]:1234", "http://[::1]:1234/v1"],
    ["https://localhost:11434", "https://localhost:11434/v1"],
    ["url: https://api.example.com/openai", "https://api.example.com/openai"],
    ["baseURL=api.example.com/v1/chat/completions", "https://api.example.com/v1"],
    ["http://localhost:4096/v1", "http://localhost:4096/v1"],
  ]) {
    expect(providerBaseURL(input)).toBe(output)
    expect(validateProviderURL(input, "openai", t).baseURL).toBe(output)
    expect(
      validateCustomProvider({
        form: {
          providerID: "test",
          name: "Test",
          baseURL: input,
          apiKey: "",
          models: [{ row: "0", id: "test", name: "Test", err: {} }],
          headers: [],
          err: {},
        },
        t,
        disabledProviders: [],
        existingProviderIDs: new Set<string>(),
      }).result?.config.options.baseURL,
    ).toBe(output)
  }
  for (const [input, reason] of [
    [" ", "required"],
    ["url:", "required"],
    ["bad address", "format"],
    ["ftp://api.example.com", "protocol"],
    ["file:///tmp/key", "protocol"],
    ["https://user:password@api.example.com", "credentials"],
    ["user:pw@host.com", "credentials"],
    ["https://api.example.com?key=test", "query"],
    ["https://api.example.com?", "query"],
    ["https://api.example.com#fragment", "fragment"],
  ]) {
    expect(() => providerBaseURL(input)).toThrow(reason)
    expect(validateProviderURL(input, "openai", t).error).toBe(`provider.custom.error.baseURL.${reason}`)
    const result = validateCustomProvider({
      form: {
        providerID: "test",
        name: "Test",
        baseURL: input,
        apiKey: "",
        models: [{ row: "0", id: "test", name: "Test", err: {} }],
        headers: [],
        err: {},
      },
      t,
      disabledProviders: [],
      existingProviderIDs: new Set<string>(),
    })
    expect(result.result).toBeUndefined()
    expect(result.err.baseURL).toBe(`provider.custom.error.baseURL.${reason}`)
  }
})

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
