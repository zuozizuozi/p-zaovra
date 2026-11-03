import { expect, test } from "bun:test"

for (const fixture of ["frontend-controls549.fixture.tsx", "sidebar-permission550.fixture.tsx"])
  test(
    "549/550 live controls: " + fixture,
    async () => {
      const child = Bun.spawn(
        [
          process.execPath,
          "test",
          "--conditions=browser",
          "--preload",
          "./happydom.ts",
          "--preload",
          "./test-browser/fixtures/solid-preload.ts",
          "./test-browser/fixtures/" + fixture,
        ],
        { cwd: import.meta.dir + "/..", stdout: "pipe", stderr: "pipe" },
      )
      const [out, error, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect(exit, out + error).toBe(0)
    },
    30_000,
  )
