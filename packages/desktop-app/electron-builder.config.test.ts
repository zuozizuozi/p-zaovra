import { expect, test } from "bun:test"
import type { Configuration } from "electron-builder"

const legacyDesktopEntry = "resources/linux/zaovra-desktop.desktop"

test("passes the trusted Windows publisher to update metadata generation", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      'const c = (await import("./electron-builder.config.ts")).default; console.log(JSON.stringify({ verify: c.win.verifyUpdateCodeSignature, publisher: c.win.signtoolOptions.publisherName }))',
    ],
    {
      cwd: import.meta.dir,
      env: { ...process.env, WINDOWS_SIGNING_PUBLISHER_NAME: "  Fixture Publisher  " },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(code, stderr).toBe(0)
  expect(JSON.parse(stdout)).toEqual({ verify: true, publisher: "Fixture Publisher" })
})

test.skipIf(process.platform !== "win32")("rejects CI signing without an explicit update publisher", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      'const c = (await import("./electron-builder.config.ts")).default; await c.win.signtoolOptions.sign({ path: "fixture.exe" })',
    ],
    {
      cwd: import.meta.dir,
      env: { ...process.env, GITHUB_ACTIONS: "true", WINDOWS_SIGNING_PUBLISHER_NAME: " " },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(code).not.toBe(0)
  expect(stdout + stderr).toContain("WINDOWS_SIGNING_PUBLISHER_NAME is required")
})

const channels = [
  { channel: "dev", appId: "ai.zaovra.desktop.dev" },
  { channel: "beta", appId: "ai.zaovra.desktop.beta" },
  { channel: "prod", appId: "ai.zaovra.desktop" },
] as const

for (const channel of channels) {
  test(`uses one Linux desktop identity for ${channel.channel}`, async () => {
    const previous = process.env.ZAOVRA_CHANNEL
    process.env.ZAOVRA_CHANNEL = channel.channel

    const module = await import(`./electron-builder.config.ts?channel=${channel.channel}`)
    const config = module.default as Configuration

    if (previous === undefined) delete process.env.ZAOVRA_CHANNEL
    else process.env.ZAOVRA_CHANNEL = previous

    expect(config.appId).toBe(channel.appId)
    expect(config.extraMetadata?.desktopName).toBe(`${channel.appId}.desktop`)
    expect(config.linux?.executableName).toBe(channel.appId)
    expect(config.linux?.desktop?.entry?.StartupWMClass).toBe(channel.appId)
  })
}

test("keeps a hidden prod launcher for old Linux pins", async () => {
  const previous = process.env.ZAOVRA_CHANNEL
  process.env.ZAOVRA_CHANNEL = "prod"

  const module = await import("./electron-builder.config.ts?compat=prod")
  const config = module.default as Configuration

  if (previous === undefined) delete process.env.ZAOVRA_CHANNEL
  else process.env.ZAOVRA_CHANNEL = previous

  expect(config.deb?.fpm?.[0]).toEndWith(`${legacyDesktopEntry}=/usr/share/applications/zaovra-desktop.desktop`)
  expect(config.rpm?.fpm?.[0]).toEndWith(`${legacyDesktopEntry}=/usr/share/applications/zaovra-desktop.desktop`)

  const desktop = await Bun.file(legacyDesktopEntry).text()
  expect(desktop).toContain("Exec=/opt/Zaovra/ai.zaovra.desktop %U")
  expect(desktop).toContain("Icon=ai.zaovra.desktop")
  expect(desktop).toContain("StartupWMClass=ai.zaovra.desktop")
  expect(desktop).toContain("NoDisplay=true")
})
