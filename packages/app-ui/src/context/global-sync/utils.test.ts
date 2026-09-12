import { describe, expect, test } from "bun:test"
import { adaptAgent, directoryKey } from "./utils"

describe("adaptAgent", () => {
  test("preserves the executor agent identity, selection and ordered permissions", () => {
    const permissions = [
      { action: "edit", resource: "*", effect: "deny" },
      { action: "edit", resource: "src/*", effect: "allow" },
      { action: "edit", resource: "src/private/*", effect: "ask" },
    ] as const
    expect(
      adaptAgent({
        id: "reviewer",
        mode: "subagent",
        hidden: false,
        color: "accent",
        steps: 4,
        model: { id: "review", providerID: "native", variant: "deep" },
        system: "Review actual changes",
        permissions: [...permissions],
        request: { headers: { "x-agent": "review" }, body: { temperature: 0.2 } },
      }),
    ).toMatchObject({
      name: "reviewer",
      mode: "subagent",
      hidden: false,
      color: "accent",
      steps: 4,
      model: { modelID: "review", providerID: "native" },
      variant: "deep",
      prompt: "Review actual changes",
      permission: permissions,
      options: { temperature: 0.2 },
    })
  })
})

describe("directoryKey", () => {
  test("normalizes slashes", () => {
    expect(String(directoryKey("C:\\Repos\\sst\\zaovra"))).toBe("C:/Repos/sst/zaovra")
    expect(String(directoryKey("C:/Repos/sst/zaovra"))).toBe("C:/Repos/sst/zaovra")
  })

  test("preserves backslashes in posix paths", () => {
    expect(String(directoryKey("/tmp/foo\\bar"))).toBe("/tmp/foo\\bar")
  })

  test("trims trailing slashes without breaking roots", () => {
    expect(String(directoryKey("C:/Repos/sst/zaovra/"))).toBe("C:/Repos/sst/zaovra")
    expect(String(directoryKey("C:/"))).toBe("C:/")
    expect(String(directoryKey("/"))).toBe("/")
  })
})
