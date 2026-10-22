import { expect, test } from "bun:test"

test("server transport lifecycle in an isolated Solid runtime", async () => {
  const child = Bun.spawn([
    process.execPath, "test", "--conditions=browser", "--preload", "./happydom.ts",
    "--preload", "./test-browser/fixtures/solid-preload.ts",
    "./test-browser/fixtures/server-transport.fixture.ts",
  ], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ])
  expect({ code, output: code ? stdout + stderr : "" }).toEqual({ code: 0, output: "" })
}, 70_000)
