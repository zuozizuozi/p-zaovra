import { expect, test } from "bun:test"

test("565 shared feedback entries, session selection, payload and screenshot limits", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "test",
      "--conditions=browser",
      "--preload",
      "./happydom.ts",
      "--preload",
      "./test-browser/fixtures/solid-preload.ts",
      "./test-browser/fixtures/feedback565.fixture.tsx",
    ],
    { cwd: import.meta.dir + "/..", stdout: "pipe", stderr: "pipe" },
  )
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(exit, stdout + stderr).toBe(0)
}, 30_000)
