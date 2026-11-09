import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"

test("790 actual Solid ownership and attachment controls", () => {
  const result = spawnSync(
    process.execPath,
    [
      "test",
      "--conditions=browser",
      "--preload",
      "./happydom.ts",
      "--preload",
      "./test-browser/fixtures/solid-preload.ts",
      "./test-browser/fixtures/ownership790.fixture.tsx",
    ],
    { cwd: process.cwd(), encoding: "utf8", timeout: 60000 },
  )
  if (result.status !== 0) throw new Error(result.stdout + result.stderr)
  expect(result.status).toBe(0)
}, 65000)
