import { describe, expect, test } from "bun:test"
import { credentialConnectionIDs, integrationLocation, providerConnectionMethods } from "./provider-integration"

describe("provider integration helpers", () => {
  test("the OpenAI connection dialog offers only API key authentication even with an older server", () => {
    const methods = [
      { type: "key" as const, label: "API key" },
      { type: "oauth" as const, id: "chatgpt-browser", label: "ChatGPT Pro/Plus" },
      { type: "env" as const, names: ["OPENAI_API_KEY"] },
    ]
    expect(providerConnectionMethods("openai", methods)).toEqual([{ type: "key", label: "API key" }])
    expect(providerConnectionMethods("supported-oauth", methods)).toEqual([
      { type: "key", label: "API key" },
      { type: "oauth", id: "chatgpt-browser", label: "ChatGPT Pro/Plus" },
    ])
  })

  test("keeps location explicit only when a directory is selected", () => {
    expect(integrationLocation()).toBeUndefined()
    expect(integrationLocation("C:\\work")).toEqual({ directory: "C:\\work" })
  })

  test("selects only removable credential connections", () => {
    expect(
      credentialConnectionIDs({
        id: "openai",
        name: "OpenAI",
        methods: [],
        connections: [
          { type: "env", name: "OPENAI_API_KEY" },
          { type: "credential", id: "cred_1", label: "Personal" },
        ],
      }),
    ).toEqual(["cred_1"])
  })
})
