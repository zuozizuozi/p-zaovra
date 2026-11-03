import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"

test.each([
  ["prod", "zaovra"],
  ["beta", "zaovra-beta"],
  ["dev", "zaovra-dev"],
  ["latest", "zaovra"],
] as const)("packages %s with its isolated protocol", async (channel, scheme) => {
  const result = Bun.spawn(
    [
      process.execPath,
      "-e",
      'import config from "./electron-builder.config.ts"; console.log(JSON.stringify(config.protocols))',
    ],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { ...process.env, ZAOVRA_CHANNEL: channel },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const [stdout, stderr, code] = await Promise.all([
    new Response(result.stdout).text(),
    new Response(result.stderr).text(),
    result.exited,
  ])
  expect(stderr).toBe("")
  expect(code).toBe(0)
  expect(JSON.parse(stdout).schemes).toEqual([scheme])
})
