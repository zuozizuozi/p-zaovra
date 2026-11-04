import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { AppInfo } from "app-builder-lib/out/appInfo"
import { getWindowsInstallationDirName } from "app-builder-lib/out/targets/targetUtil"

test.each([
  ["prod", "fbddedf8-1423-5de4-8bdd-ac14b5197666"],
  ["beta", "ba4cdc26-99a6-5b17-891a-309ad8f2da29"],
  ["dev", "2e9fc3e5-150a-5caa-95e1-b540a8ed93e1"],
] as const)("%s actual NSIS directory resolver uses its own name and installer identity", async (channel, identity) => {
  const child = Bun.spawn(
    [process.execPath, "-e", 'import config from "./electron-builder.config.ts"; console.log(JSON.stringify(config))'],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { ...process.env, ZAOVRA_CHANNEL: channel, ZAOVRA_ALLOW_UNSIGNED_BETA: "false" },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(code).toBe(0)
  expect(stderr).toBe("")
  const config = JSON.parse(stdout)
  const info = new AppInfo({
    metadata: { name: config.extraMetadata.name ?? "@zaovra-ai/desktop", version: "0.1.1" },
    config,
  } as ConstructorParameters<typeof AppInfo>[0])
  const directory = getWindowsInstallationDirName(info, false)
  expect(directory).toBe(channel === "prod" ? "zaovra-desktop" : `zaovra-desktop-${channel}`)
  expect(config.nsis.guid).toBe(identity)
  expect(await Bun.file(new URL(`../${config.nsis.include}`, import.meta.url)).text()).toContain(
    `!define ZAOVRA_SCHEME "${channel === "prod" ? "zaovra" : `zaovra-${channel}`}"`,
  )
})

// Exercise electron-builder's actual Linux AppInfo value used by FpmTarget's /opt path.
test.each(["prod", "beta", "dev"] as const)("%s Linux /opt install path has no whitespace", async (channel) => {
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      'import {getConfig} from "./electron-builder.config.ts"; console.log(JSON.stringify(getConfig("linux")))',
    ],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { ...process.env, ZAOVRA_CHANNEL: channel, ZAOVRA_ALLOW_UNSIGNED_BETA: "false" },
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
  const config = JSON.parse(stdout)
  const info = new AppInfo({
    metadata: { name: config.extraMetadata.name, version: "0.1.1" },
    config,
  } as ConstructorParameters<typeof AppInfo>[0])
  expect(`/opt/${info.sanitizedProductName}`).toBe(channel === "prod" ? "/opt/zaovra" : `/opt/zaovra-${channel}`)
  expect(config.linux.desktop.entry.Name).toBe(
    channel === "prod" ? "Zaovra" : channel === "beta" ? "Zaovra Beta" : "Zaovra Dev",
  )
  if (channel === "prod")
    expect(await Bun.file(new URL("../resources/linux/zaovra-desktop.desktop", import.meta.url)).text()).toContain(
      `Exec=/opt/${info.sanitizedProductName}/${config.linux.executableName} %U`,
    )
})
