import { expect, test } from "bun:test"

test("811 actual deliverable cards and terminal panel DOM regression", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "test",
      "--conditions=browser",
      "--preload",
      "./happydom.ts",
      "--preload",
      "./test-browser/fixtures/solid-preload.ts",
      "./test-browser/fixtures/deliverables-terminal.fixture.tsx",
    ],
    { cwd: import.meta.dir + "/..", stdout: "pipe", stderr: "pipe" },
  )
  const timer = setTimeout(() => child.kill(), 25_000)
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  clearTimeout(timer)
  process.stdout.write(out)
  process.stderr.write(err)
  expect(code, out + err).toBe(0)
}, 30_000)
