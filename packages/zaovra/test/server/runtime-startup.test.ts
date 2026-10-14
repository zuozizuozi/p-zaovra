import { expect, test } from "bun:test"
import path from "node:path"

// Separate processes are essential: a second test in one Bun process would
// merely reuse whichever entrypoint won the first initialization race.
for (const order of ["runtime-first", "http-first"]) {
  test(`durable config refresh and LSP work with ${order}`, async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        "test",
        "--timeout",
        "30000",
        "--preload",
        "./test/fixture/runtime-startup.ts",
        "test/server/httpapi-config.test.ts",
        "test/server/httpapi-lsp-session.test.ts",
      ],
      {
        cwd: path.resolve(import.meta.dir, "../.."),
        env: { ...process.env, ZAOVRA_TEST_STARTUP_ORDER: order },
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
      expect({ code, output: stdout + stderr }).toEqual({ code: 0, output: expect.any(String) })
      expect(stderr).toContain("15 pass")
      expect(stderr).toContain("0 fail")
      expect(stdout).toContain("shared-runtime-identity-ok")
    } finally {
      child.kill()
      await child.exited
    }
  }, 120_000)
}
