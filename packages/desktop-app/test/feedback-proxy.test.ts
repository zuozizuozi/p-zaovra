import { expect, test } from "bun:test"

test("Solid browser-store proxy projection keeps the exact feedback preview", async () => {
  const child = Bun.spawn([process.execPath, "test", "--conditions=browser", "./test-node/feedback-proxy.fixture.ts"], {
    cwd: import.meta.dir + "/..",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(code, out + err).toBe(0)
})
