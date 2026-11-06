import { expect, test } from "bun:test"

test("701 actual Solid reasoning control DOM", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "test",
      "--conditions=browser",
      "--preload",
      "./happydom.ts",
      "--preload",
      "./test-browser/fixtures/solid-preload.ts",
      "./test-browser/fixtures/reasoning701.fixture.tsx",
    ],
    { stdout: "pipe", stderr: "pipe", env: process.env },
  )
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect({ code, output: code ? stdout + stderr : "" }).toEqual({ code: 0, output: "" })
})
