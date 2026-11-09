import { expect, test } from "bun:test"
import { formatVersion } from "./updater"

test("780 uses the visible Beta version without changing legacy or stable identities", () => {
  expect(formatVersion("0.2.0-beta.1")).toBe("Beta 0.2.0")
  expect(formatVersion("0.2.1-beta.1")).toBe("Beta 0.2.1")
  expect(formatVersion("0.2.2-beta.1")).toBe("Beta 0.2.2")
  expect(formatVersion("0.1.1-beta.19")).toBe("0.1.1-beta.19")
  expect(formatVersion("0.2.0")).toBe("0.2.0")
  expect(formatVersion("0.0.0-dev")).toBe("0.0.0-dev")
  expect(formatVersion(undefined)).toBe("")
})
