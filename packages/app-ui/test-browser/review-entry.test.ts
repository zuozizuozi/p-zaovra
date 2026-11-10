import { expect, test } from "bun:test"

test("807 actual Solid changes controls and side-panel cold-start regression", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "test",
      "--conditions=browser",
      "--preload",
      "./happydom.ts",
      "--preload",
      "./test-browser/fixtures/solid-preload.ts",
      "./test-browser/fixtures/review-entry.fixture.tsx",
    ],
    { cwd: import.meta.dir + "/..", stdout: "pipe", stderr: "pipe" },
  )
  const timeout = setTimeout(() => child.kill(), 25_000)
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  clearTimeout(timeout)
  process.stdout.write(out)
  process.stderr.write(err)
  expect(code, out + err).toBe(0)
}, 30_000)
