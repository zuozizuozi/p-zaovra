import { expect, test } from "bun:test"
import path from "node:path"

test("merge approval dispatch survives a stopped listener", async () => {
  // A fresh process ensures Server.Default has not already retained the projector.
  const child = Bun.spawn(
    [
      process.execPath,
      "test",
      "--timeout",
      "30000",
      "--preload",
      "./test/fixture/work-listener-cycle.ts",
      "test/server/httpapi-merge-wake.test.ts",
      "--test-name-pattern",
      "merge approval dispatch: idle",
    ],
    { cwd: path.resolve(import.meta.dir, "../.."), env: process.env, stdout: "pipe", stderr: "pipe" },
  )
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect({ code, output: stdout + stderr }).toEqual({ code: 0, output: expect.any(String) })
    expect(stdout).toContain("work-listener-stopped")
    expect(stderr).toContain("1 pass")
    expect(stderr).toContain("0 fail")
  } finally {
    child.kill()
    await child.exited
  }
}, 60_000)
