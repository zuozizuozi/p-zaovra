import { expect, test } from "bun:test"
import path from "node:path"

// The real database node captures its path on import. Keep the fixture's owner
// lifecycle and temporary database out of the package test process.
test("embedded tool verdict lifecycle is isolated", async () => {
  const child = Bun.spawn([process.execPath, "test", "./test/fixture/embedded-disposition.fixture.ts"], {
    cwd: path.resolve(import.meta.dir, ".."),
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  })
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(code, stdout + stderr).toBe(0)
    expect(stderr).toContain("1 pass")
    expect(stderr).toContain("0 fail")
  } finally {
    child.kill()
    await child.exited
  }
}, 60000)
