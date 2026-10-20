import { expect, test } from "bun:test"

// Module substitutions stay in a child process, away from other provider tests.
test("FileProvider refresh integration", async () => {
  const child = Bun.spawn([
    process.execPath, "test", "--conditions=browser", "--preload", "./happydom.ts",
    "./test-browser/fixtures/file-provider-refresh.fixture.ts",
  ], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ])
  expect({ code, output: code ? stdout + stderr : "" }).toEqual({ code: 0, output: "" })
})