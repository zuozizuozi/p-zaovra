import { expect, test } from "bun:test"

test("browser screenshot integration in an isolated Solid runtime", async () => {
  const child = Bun.spawn([
    process.execPath, "test", "--conditions=browser", "--preload", "./happydom.ts",
    "--preload", "./test-browser/fixtures/solid-preload.ts",
    "./test-browser/fixtures/browser-screenshot.fixture.ts",
  ], { stdout: "pipe", stderr: "pipe" })
  // Bun's test timeout does not terminate a spawned runtime.
  const timeout = setTimeout(() => child.kill(), 30_000)
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ])
    expect({ code, output: code ? stdout + stderr : "" }).toEqual({ code: 0, output: "" })
  } finally {
    clearTimeout(timeout)
    child.kill()
    await child.exited
  }
}, 35_000)
