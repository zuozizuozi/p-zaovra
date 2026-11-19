import { expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"

test("production memory tidy resumes only an admitted budget checkpoint", async () => {
  await using temporary = await tmpdir()
  const child = Bun.spawn(
    [process.execPath, "test", "--timeout", "45000", "./test/fixture/memory-tidy-resume.fixture.ts"],
    {
      cwd: import.meta.dir + "/../..",
      env: {
        ...process.env,
        ZAOVRA_SERVER_TEST_DIR: temporary.path,
        TEMP: temporary.path,
        TMP: temporary.path,
        TMPDIR: temporary.path,
      },
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
  } finally {
    child.kill()
    await child.exited
  }
}, 60_000)
