import { expect, test } from "bun:test"
import { adaptProviderCatalog } from "./provider-catalog"

test("612 domain-only saved services have brand names and empty catalogs inject no test presets", () => {
  const catalog = adaptProviderCatalog(
    [],
    [],
    [
      { id: "gravitex", name: "api.gravitex.ai", methods: [{ type: "key", label: "Key" }], connections: [] },
      { id: "edge", name: "api.edgecloudapp.com", methods: [{ type: "key", label: "Key" }], connections: [] },
      { id: "custom", name: "My custom account", methods: [{ type: "key", label: "Key" }], connections: [] },
    ],
  )
  expect(catalog.all.get("gravitex")?.name).toBe("万引")
  expect(catalog.all.get("edge")?.name).toBe("EdgeCloud")
  expect(catalog.all.get("custom")?.name).toBe("My custom account")
  expect(adaptProviderCatalog([], [], []).all.size).toBe(0)
  expect(adaptProviderCatalog([], [], []).connected).toEqual([])
})

test("saved provider credentials remain removable without inventing available models", () => {
  const catalog = adaptProviderCatalog(
    [],
    [],
    [
      {
        id: "openai",
        name: "OpenAI",
        methods: [{ type: "key", label: "API key" }],
        connections: [{ type: "credential", id: "cred_old", label: "Old ChatGPT login" }],
      },
      {
        id: "mcp-example",
        name: "MCP example",
        methods: [{ type: "oauth", id: "mcp-oauth", label: "OAuth" }],
        connections: [{ type: "credential", id: "cred_mcp", label: "MCP account" }],
      },
    ],
  )
  expect(catalog.connected).toEqual(["openai"])
  expect(catalog.all.get("openai")?.models).toEqual({})
  expect(catalog.all.get("openai")?.options).toMatchObject({
    credentialOnly: true,
    credentialLabels: ["Old ChatGPT login"],
    supportsOAuth: false,
  })
  expect(catalog.all.get("mcp-example")?.options.supportsOAuth).toBe(true)
})
