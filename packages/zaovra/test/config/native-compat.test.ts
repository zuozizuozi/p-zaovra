import { expect, test } from "bun:test"
import { ConfigParse } from "../../src/config/parse"

test("unknown future config fields remain rejected across shared dev/prod configs", () => {
  expect(() => ConfigParse.legacyConfiguration({ future_dev_only_field: true }, "fixture.json")).toThrow()
})

test("legacy bootstrap accepts validated native settings without mutating authored config", () => {
  const authored = {
    session_token_budget: 160000,
    session_output: { provider: { model: { initial: 16000, maximum: 64000 } } },
    permissions: [{ action: "*", resource: "*", effect: "allow" }],
    model: "provider/model",
  }
  const before = JSON.stringify(authored)
  expect(ConfigParse.legacyConfiguration(authored, "fixture.json")).toEqual({ model: "provider/model" })
  expect(JSON.stringify(authored)).toBe(before)
  expect(ConfigParse.configuration(authored, "fixture.json").session_token_budget).toBe(160000)
  expect(ConfigParse.configuration(authored, "fixture.json").session_output).toEqual(authored.session_output)
})

test("legacy bootstrap still rejects unknown or malformed native settings", () => {
  for (const value of [
    { session_token_budget: -1 },
    { session_token_budget: "lots" },
    { session_output: { provider: { model: { initial: 0, maximum: 64000 } } } },
    { session_token_budegt: 100 },
    { permissions: [{ effect: "oops" }] },
  ])
    expect(() => ConfigParse.legacyConfiguration(value, "fixture.json")).toThrow()
})
