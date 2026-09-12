import { describe, expect, test } from "bun:test"
import { configuredModelIDs, modelSource } from "./model-source"

describe("model availability and billing source", () => {
  test("official ownership follows integration rather than a vendor's display name", () => {
    expect(modelSource({ id: "openai", options: { integrationID: "zaovra" } })).toBe("official")
    expect(modelSource({ id: "openai" })).toBe("own")
    expect(modelSource({ id: "zaovra" })).toBe("official")
  })
  test("only explicit models are selectable, including an existing configured default", () => {
    expect([...configuredModelIDs()]).toEqual([])
    expect([...configuredModelIDs({ models: { custom: {} } }, "default")]).toEqual(["custom", "default"])
  })
  test("a discovered allowlist takes precedence over stale definitions and defaults", () => {
    expect([...configuredModelIDs({ whitelist: ["current"], models: { old: {} } }, "old")]).toEqual(["current"])
    expect([...configuredModelIDs({ whitelist: [] }, "old")]).toEqual([])
  })
})
