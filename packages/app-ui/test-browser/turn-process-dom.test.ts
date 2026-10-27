import { expect, test } from "bun:test"

test("turn process and original failure DOM in an isolated Solid runtime", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "test",
      "--conditions=browser",
      "--preload",
      "./happydom.ts",
      "--preload",
      "./test-browser/fixtures/solid-preload.ts",
      "./test-browser/fixtures/turn-process.fixture.tsx",
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
