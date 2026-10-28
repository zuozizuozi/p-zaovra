import { expect, test } from "bun:test"

test("real outcome dock recovery lifecycle in an isolated Solid/query runtime", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "test",
      "--conditions=browser",
      "--preload",
      "./happydom.ts",
      "--preload",
      "./test-browser/fixtures/solid-preload.ts",
      "./test-browser/fixtures/outcome-recovery.fixture.tsx",
    ],
    { stdout: "pipe", stderr: "pipe", env: process.env },
  )
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect({ code, output: code ? stdout + stderr : "" }).toEqual({ code: 0, output: "" })
}, 30000)
