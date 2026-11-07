import { expect, test } from "bun:test"

test.each(["pinned728", "permission728", "options728"])(
  "728 %s actual Solid DOM regression",
  async (fixture) => {
    const child = Bun.spawn(
      [
        process.execPath,
        "test",
        "--conditions=browser",
        "--preload",
        "./happydom.ts",
        "--preload",
        "./test-browser/fixtures/solid-preload.ts",
        "./test-browser/fixtures/" + fixture + ".fixture.tsx",
      ],
      { cwd: import.meta.dir + "/..", stdout: "pipe", stderr: "pipe" },
    )
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(code, stdout + stderr).toBe(0)
  },
  30_000,
)
