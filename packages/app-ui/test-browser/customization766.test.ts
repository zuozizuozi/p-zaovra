import { expect, test } from "bun:test"

test("766 customization UI, fixed entry and slash admission use the actual Solid compiler", async () => {
  for (const file of ["customization-ui766.fixture.tsx", "customize-entry766.fixture.tsx", "slash766.fixture.ts"]) {
    const child = Bun.spawn(
      [
        process.execPath,
        "test",
        "--conditions=browser",
        "--preload",
        "./happydom.ts",
        "--preload",
        "./test-browser/fixtures/solid-preload.ts",
        "./test-browser/fixtures/" + file,
      ],
      {
        cwd: import.meta.dir + "/..",
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(code, out + err).toBe(0)
  }
}, 30000)

// This protocol fixture writes only to an explicitly supplied isolated profile.
const integration = process.env.ZAOVRA_766_TEST_ROOT ? test : test.skip
integration(
  "766 five-round real HTTP and MCP persistence",
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
        "./test-browser/fixtures/customization766.fixture.tsx",
      ],
      {
        cwd: import.meta.dir + "/..",
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(code, out + err).toBe(0)
  },
  180000,
)
