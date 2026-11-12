import { expect, test } from "bun:test"

// TODO(dom-fixtures): the first dialog opened in a fresh happy-dom process never renders, whichever case runs
// first, so one case always fails. Confirm first-open in the real app, then repair the fixture.
test.todo(
  "789 actual reset confirmation dialog and read-only hook",
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
        "./test-browser/fixtures/revert789.fixture.tsx",
      ],
      { cwd: import.meta.dir + "/..", stdout: "pipe", stderr: "pipe" },
    )
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(code, out + err).toBe(0)
  },
  30_000,
)
