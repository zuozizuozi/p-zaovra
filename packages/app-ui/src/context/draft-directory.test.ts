import { expect, test } from "bun:test"
import { resolveDraftDirectory } from "./draft-directory"

test("skips only confirmed missing projects and deduplicates candidates", async () => {
  const checked: string[] = []
  expect(
    await resolveDraftDirectory({
      directory: "/gone",
      alternatives: ["/gone", "/also-gone", "/valid"],
      check: async (directory) => {
        checked.push(directory)
        if (directory !== "/valid") throw { name: "DirectoryUnavailableError", data: { directory } }
      },
    }),
  ).toBe("/valid")
  expect(checked).toEqual(["/gone", "/also-gone", "/valid"])
})

test("no available project returns selection instead of a missing directory", async () => {
  expect(
    await resolveDraftDirectory({
      directory: "/gone",
      alternatives: [],
      check: async (directory) => {
        throw { name: "DirectoryUnavailableError", data: { directory } }
      },
    }),
  ).toBeUndefined()
})

test.each([
  new Error("Network unavailable"),
  { name: "PermissionDeniedError" },
  { name: "DirectoryUnavailableError", data: { directory: "/different" } },
])("does not discard projects for unrelated failures: %j", async (error) => {
  const checked: string[] = []
  expect(
    await resolveDraftDirectory({
      directory: "/project",
      alternatives: ["/other"],
      check: async (directory) => {
        checked.push(directory)
        throw error
      },
    }),
  ).toBe("/project")
  expect(checked).toEqual(["/project"])
})
