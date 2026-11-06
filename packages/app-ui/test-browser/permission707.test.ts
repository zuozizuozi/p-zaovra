import { expect, test } from "bun:test"

test("707 automatic reply failure integrates with real permission mode state and manual recovery", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "test",
      "--conditions=browser",
      "--preload",
      "./happydom.ts",
      "--preload",
      "./test-browser/fixtures/solid-preload.ts",
      "./test-browser/fixtures/permission707.fixture.tsx",
    ],
    { cwd: import.meta.dir + "/..", stdout: "pipe", stderr: "pipe" },
  )
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (process.env.ZAOVRA_TEST_REPORT_DIR) {
    const report = process.env.ZAOVRA_TEST_REPORT_DIR + "/permission707-" + crypto.randomUUID()
    await Promise.all([
      Bun.write(report + ".stdout.log", stdout),
      Bun.write(report + ".stderr.log", stderr),
      Bun.write(report + ".result.json", JSON.stringify({ actual_exit: exit, signal: child.signalCode, cases: 10 })),
    ])
    console.log("PERMISSION707_FIXTURE_REPORT", report)
  }
  expect(exit, stdout + stderr).toBe(0)
}, 30_000)
