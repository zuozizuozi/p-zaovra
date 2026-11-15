import { expect, test } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import os from "node:os"

// Production environment and runtime owners belong to the child process only.
test("production tidy listener lifetime is isolated from the test batch", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tidy-lifetime-"))
  const child = Bun.spawn([process.execPath, "test", "--timeout", "30000", "./src/routes-memory-lifetime.fixture.ts"], {
    cwd: path.resolve(import.meta.dir, ".."),
    env: { ...process.env, ZAOVRA_SERVER_TEST_DIR: root },
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
    expect(stderr).toContain("20 expect() calls")
  } finally {
    child.kill()
    await child.exited
    await fs.rm(root, { recursive: true, force: true })
  }
}, 60000)
