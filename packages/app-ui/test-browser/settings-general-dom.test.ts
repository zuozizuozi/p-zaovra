import { expect, test } from "bun:test"

test.each(["0", "1"])("general settings page DOM integration (legacy=%s)", async (legacy) => {
  const child = Bun.spawn([
    process.execPath, "test", "--conditions=browser", "--preload", "./happydom.ts",
    "--preload", "./test-browser/fixtures/solid-preload.ts",
    "./test-browser/fixtures/settings-general.fixture.ts",
  ], { stdout: "pipe", stderr: "pipe", env: { ...process.env, O5_LEGACY: legacy } })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ])
  expect({ code, output: code ? stdout + stderr : "" }).toEqual({ code: 0, output: "" })
})


