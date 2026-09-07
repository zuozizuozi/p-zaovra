import { describe, expect, test } from "bun:test"
import { requireApiKey } from "../src/routes/zen/util/accessPolicy"

describe("managed model access policy", () => {
  test("rejects requests without credentials", () => {
    expect(() => requireApiKey(undefined)).toThrow("Connect your own provider or subscribe to ZAOVRA")
  })

  test("rejects the retired public credential", () => {
    expect(() => requireApiKey("public")).toThrow("Connect your own provider or subscribe to ZAOVRA")
  })

  test("accepts an authenticated credential", () => {
    expect(requireApiKey("zaovra-key")).toBe("zaovra-key")
  })
})
