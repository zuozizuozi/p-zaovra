import { expect, test } from "bun:test"
import type { Configuration } from "electron-builder"

const legacyDesktopEntry = "resources/linux/zaovra-desktop.desktop"

for (const channel of ["beta", "prod", "latest", "dev"]) {
  test(`572 explicit unsigned build is confined to beta, requested ${channel}`, async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        'const c = (await import("./electron-builder.config.ts")).default; await c.win.signtoolOptions.sign({ path: "not-a-real-installer.exe" }); console.log(JSON.stringify({ verify: c.win.verifyUpdateCodeSignature, publisher: c.win.signtoolOptions.publisherName }))',
      ],
      {
        cwd: import.meta.dir,
        env: {
          ZAOVRA_CHANNEL: channel,
          ZAOVRA_ALLOW_UNSIGNED_BETA: "true",
          GITHUB_ACTIONS: "true",
          WINDOWS_SIGNING_PUBLISHER_NAME: "Fixture Publisher Must Not Enter Unsigned Metadata",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (channel === "beta") {
      expect(code, stderr).toBe(0)
      expect(JSON.parse(stdout)).toEqual({ verify: false })
      return
    }
    expect(code).not.toBe(0)
    expect(stderr).toContain("ZAOVRA_ALLOW_UNSIGNED_BETA requires ZAOVRA_CHANNEL=beta")
  })
}

test.skipIf(process.platform !== "win32")(
  "572 beta without the explicit unsigned switch still requires its CI signing publisher",
  async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        'const c = (await import("./electron-builder.config.ts")).default; await c.win.signtoolOptions.sign({ path: "not-a-real-installer.exe" })',
      ],
      {
        cwd: import.meta.dir,
        env: { ZAOVRA_CHANNEL: "beta", GITHUB_ACTIONS: "true" },
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
  },
)

test("572 prod retains publisher metadata and update signature verification", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      'const c = (await import("./electron-builder.config.ts")).default; console.log(JSON.stringify({ verify: c.win.verifyUpdateCodeSignature, publisher: c.win.signtoolOptions.publisherName }))',
    ],
    {
      cwd: import.meta.dir,
      env: { ZAOVRA_CHANNEL: "prod", WINDOWS_SIGNING_PUBLISHER_NAME: "Fixture Publisher" },
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
  { channel: "dev", appId: "ai.zaovra.desktop.dev", productName: "zaovra-dev" },
  { channel: "beta", appId: "ai.zaovra.desktop.beta", productName: "zaovra-beta" },
  { channel: "prod", appId: "ai.zaovra.desktop", productName: "zaovra" },
] as const

for (const channel of channels) {
  test(`uses one Linux desktop identity for ${channel.channel}`, async () => {
    const previous = process.env.ZAOVRA_CHANNEL
    process.env.ZAOVRA_CHANNEL = channel.channel

    const module = await import(`./electron-builder.config.ts?channel=${channel.channel}`)
    const config = module.getConfig("linux") as Configuration

    if (previous === undefined) delete process.env.ZAOVRA_CHANNEL
    else process.env.ZAOVRA_CHANNEL = previous

    if (channel.channel === "beta") {
      expect(config.publish).toEqual({ provider: "generic", url: "https://updates.zaovra.com/beta/", channel: "beta" })
      expect(config.win?.verifyUpdateCodeSignature).toBe(true)
    }
    expect(config.productName).toBe(channel.productName)
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
  const config = module.getConfig("linux") as Configuration

  if (previous === undefined) delete process.env.ZAOVRA_CHANNEL
  else process.env.ZAOVRA_CHANNEL = previous

  expect(config.productName).toBe("zaovra")
  expect(config.linux?.executableName).toBe("ai.zaovra.desktop")
  expect(config.deb?.fpm?.[0]).toEndWith(`${legacyDesktopEntry}=/usr/share/applications/zaovra-desktop.desktop`)
  expect(config.rpm?.fpm?.[0]).toEndWith(`${legacyDesktopEntry}=/usr/share/applications/zaovra-desktop.desktop`)

  const desktop = await Bun.file(legacyDesktopEntry).text()
  expect(desktop).toContain(`Exec=/opt/${config.productName}/${config.linux?.executableName} %U`)
  expect(desktop).toContain("Icon=ai.zaovra.desktop")
  expect(desktop).toContain("StartupWMClass=ai.zaovra.desktop")
  expect(desktop).toContain("NoDisplay=true")
})

test("690 NSIS has no folder, install-mode or finish page and keeps distinct channel directories", async () => {
  const { getWindowsInstallationDirName } = await import("app-builder-lib/out/targets/targetUtil.js")
  const dirs = []
  for (const channel of ["dev", "beta", "prod"]) {
    const child = Bun.spawn(
      [process.execPath, "-e", 'console.log(JSON.stringify((await import("./electron-builder.config.ts")).default))'],
      { cwd: import.meta.dir, env: { ZAOVRA_CHANNEL: channel }, stdout: "pipe", stderr: "pipe" },
    )
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(code, err).toBe(0)
    const config = JSON.parse(out)
    // Assisted keeps existing per-machine installs in place; the folder page is gone.
    expect(config.nsis.oneClick).toBe(false)
    expect(config.nsis.allowToChangeInstallationDirectory).toBe(false)
    expect(config.nsis.runAfterFinish).toBe(true)
    expect(config.nsis.perMachine).toBe(false)
    expect(config.nsis.include).toBe(`resources/channel-${channel}.nsh`)
    dirs.push(
      getWindowsInstallationDirName(
        { productFilename: config.productName, sanitizedName: "@zaovra-aidesktop" } as never,
        !config.nsis.oneClick || config.nsis.perMachine,
      ),
    )
    if (channel === "beta")
      expect(config.extraMetadata).toMatchObject({ zaovraChannel: "beta", zaovraUnsignedBeta: false })
  }
  expect(dirs).toEqual(["Zaovra Dev", "Zaovra Beta", "Zaovra"])
  expect(new Set(dirs).size).toBe(3)
  const isolation = await Bun.file("resources/channel-isolation.nsh").text()
  expect(isolation).toMatch(/!macro customInstallMode[\s\S]*?isForceMachineInstall[\s\S]*?isForceCurrentInstall[\s\S]*?!macroend/)
  expect(isolation).toMatch(/!macro customFinishPage\s+!macroend/)
  expect(isolation).toMatch(/!macro customInstall\s[\s\S]*?SetAutoClose true[\s\S]*?ExecShellAsUser[\s\S]*?!macroend/)
  expect(isolation).toMatch(/!macro customInit\s+!insertmacro channelDirectoryGuard/)
})
