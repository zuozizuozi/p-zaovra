import { expect, test } from "bun:test"
import { adaptProviderCatalog } from "./provider-catalog"

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
