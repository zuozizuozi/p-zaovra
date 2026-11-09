import { expect, test } from "bun:test"

test("766 actual sidebar DOM and storage regressions", async () => {
  for (const fixture of ["sidebar766.fixture.tsx", "order766.persistence.fixture.ts"]) {
    const child = Bun.spawn(
      [
        process.execPath,
        "test",
        "--conditions=browser",
        "--preload",
        "./happydom.ts",
        "--preload",
        "./test-browser/fixtures/solid-preload.ts",
        `./test-browser/fixtures/${fixture}`,
      ],
      { cwd: import.meta.dir + "/..", stdout: "pipe", stderr: "pipe" },
    )
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(code, out + err).toBe(0)
  }
}, 30000)
