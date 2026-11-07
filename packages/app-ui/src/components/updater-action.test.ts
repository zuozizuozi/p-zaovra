import { expect, test } from "bun:test"

// The updater hook imports Solid TSX, which requires the DOM compiler in Bun.
test("733 updater contracts use the compiled Solid DOM runtime", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "test",
      "--conditions=browser",
      "--preload",
      "./happydom.ts",
      "--preload",
      "./test-browser/fixtures/solid-preload.ts",
      "./test-browser/fixtures/updater-action.fixture.ts",
    ],
    { cwd: import.meta.dir + "/../..", stdout: "pipe", stderr: "pipe" },
  )
  const timeout = setTimeout(() => child.kill(), 25_000)
  try {
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(exit, stdout + stderr).toBe(0)
  } finally {
    clearTimeout(timeout)
    if (child.exitCode === null) child.kill()
    await child.exited
  }
}, 30_000)
