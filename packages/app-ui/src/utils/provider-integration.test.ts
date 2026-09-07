import { describe, expect, test } from "bun:test"
import { credentialConnectionIDs, integrationLocation } from "./provider-integration"

describe("provider integration helpers", () => {
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
