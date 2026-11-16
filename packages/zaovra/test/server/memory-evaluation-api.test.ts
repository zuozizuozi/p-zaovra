import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

// The child disposes the real application runtime; it must not share other tests' owners.
test("evaluation observer uses actual Session admission and message endpoints", async () => {
  await using tmp = await tmpdir()
  const child = Bun.spawn(
    [process.execPath, "test", "--timeout", "30000", "./test/fixture/memory-evaluation-api.fixture.ts"],
    {
      cwd: path.resolve(import.meta.dir, "../.."),
      env: { ...process.env, ZAOVRA_SERVER_TEST_DIR: tmp.path, TEMP: tmp.path, TMP: tmp.path, TMPDIR: tmp.path },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
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
