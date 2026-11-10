import { expect, test } from "bun:test"

test("815 actual adapter and native filesystem deliverable-window regression", async () => {
  const child = Bun.spawn(
    [process.execPath, "--no-env-file", "test", "./test-browser/fixtures/deliverable-window.fixture.ts"],
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
