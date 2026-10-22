import { expect, test } from "bun:test"
import { ConfigParse } from "../../src/config/parse"

test("unknown future config fields are ignored across shared dev/prod configs", () => {
  const authored = { model: "provider/model", future_dev_only_field: "private-value", session_token_budegt: 100 }
  expect(ConfigParse.legacyConfiguration(authored, "fixture.json")).toEqual({ model: "provider/model" })
  expect(ConfigParse.configuration(authored, "fixture.json").model).toBe("provider/model")
  expect(ConfigParse.configuration(authored, "fixture.json")).not.toHaveProperty("future_dev_only_field")
  expect(authored.future_dev_only_field).toBe("private-value")
})

test("legacy bootstrap accepts validated native settings without mutating authored config", () => {
  const authored = {
    session_token_budget: 160000,
    session_duration_ms: 3600000,
    session_output: { provider: { model: { initial: 16000, maximum: 64000 } } },
    permissions: [{ action: "*", resource: "*", effect: "allow" }],
    model: "provider/model",
  }
  const before = JSON.stringify(authored)
  expect(ConfigParse.legacyConfiguration(authored, "fixture.json")).toEqual({
    model: "provider/model",
    session_token_budget: 160000,
    session_duration_ms: 3600000,
  })
  expect(JSON.stringify(authored)).toBe(before)
  expect(ConfigParse.configuration(authored, "fixture.json").session_token_budget).toBe(160000)
  expect(ConfigParse.configuration(authored, "fixture.json").session_output).toEqual(authored.session_output)
})

test("S1 explicit unlimited survives native and legacy config views", () => {
  const authored = { session_token_budget: null, session_duration_ms: null }
  expect(ConfigParse.configuration(authored, "fixture.json")).toMatchObject(authored)
  expect(ConfigParse.legacyConfiguration(authored, "fixture.json")).toMatchObject(authored)
})

test("native and legacy bootstrap still reject malformed known settings", () => {
  for (const value of [
    { session_token_budget: -1 },
    { session_token_budget: "lots" },
    { session_output: { provider: { model: { initial: 0, maximum: 64000 } } } },
    { permissions: [{ effect: "oops" }] },
  ]) {
    expect(() => ConfigParse.legacyConfiguration(value, "fixture.json")).toThrow()
    expect(() => ConfigParse.configuration(value, "fixture.json")).toThrow()
  }
})

test("unknown-field warnings name keys without leaking their values", async () => {
  const proc = Bun.spawn(
    [
      process.execPath,
      "-e",
      `
    import { ConfigParse } from "./src/config/parse.ts"
    ConfigParse.legacyConfiguration({ future_field: { secret: "DO_NOT_LOG_6b42" } }, "fixture.json")
  `,
    ],
    { cwd: import.meta.dir + "/../..", stdout: "pipe", stderr: "pipe" },
  )
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  expect(exit).toBe(0)
  expect(stdout + stderr).toContain("Ignoring unknown top-level configuration fields")
  expect(stdout + stderr).toContain("future_field")
  expect(stdout + stderr).not.toContain("DO_NOT_LOG_6b42")
  expect(stdout + stderr).not.toContain("secret")
})
