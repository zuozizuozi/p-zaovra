import { execFile } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import type { Configuration } from "electron-builder"
import { DEEP_LINK_PROTOCOLS } from "@zaovra-ai/app/deep-link-protocol"

const execFileAsync = promisify(execFile)
const packageDir = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(packageDir, "../..")
const signScript = path.join(rootDir, "script", "sign-windows.ps1")
const publisherName = process.env.WINDOWS_SIGNING_PUBLISHER_NAME?.trim()
// Keep the short desktop entry as an installation compatibility alias so existing
// GNOME/KDE pins continue to resolve alongside the canonical Zaovra app id.
const legacyDesktopEntry = path.join(packageDir, "resources", "linux", "zaovra-desktop.desktop")
const legacyDesktopEntryFpm = `${legacyDesktopEntry.replaceAll("\\", "/")}=/usr/share/applications/zaovra-desktop.desktop`

async function signWindows(configuration: { path: string }) {
  if (process.platform !== "win32") return
  if (unsignedBeta) return
  if (process.env.GITHUB_ACTIONS !== "true") return
  if (!publisherName) throw new Error("WINDOWS_SIGNING_PUBLISHER_NAME is required for signed Windows releases")

  await execFileAsync(
    "pwsh",
    ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", signScript, configuration.path],
    { cwd: rootDir },
  )
}

const channel = (() => {
  const raw = process.env.ZAOVRA_CHANNEL
  if (raw === "latest") return "prod"
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  return "dev"
})()

const unsignedBeta = process.env.ZAOVRA_ALLOW_UNSIGNED_BETA === "true"
if (unsignedBeta && channel !== "beta") throw new Error("ZAOVRA_ALLOW_UNSIGNED_BETA requires ZAOVRA_CHANNEL=beta")

const APP_IDS = {
  dev: "ai.zaovra.desktop.dev",
  beta: "ai.zaovra.desktop.beta",
  prod: "ai.zaovra.desktop",
} as const

// New identities must never invoke an old uninstaller whose InstallLocation
// points at the shared pre-isolation directory (which can contain another channel).
const INSTALLER_IDS = {
  prod: "fbddedf8-1423-5de4-8bdd-ac14b5197666",
  beta: "ba4cdc26-99a6-5b17-891a-309ad8f2da29",
  dev: "2e9fc3e5-150a-5caa-95e1-b540a8ed93e1",
} as const

const getBase = (appId: string): Configuration => ({
  artifactName: "zaovra-desktop-${os}-${arch}.${ext}",
  directories: {
    output: "dist",
    buildResources: "resources",
  },
  // Linux launchers are .desktop files, so this is the desktop file name,
  // not just the app id. For prod, app id "ai.zaovra.desktop" becomes
  // "ai.zaovra.desktop.desktop".
  // https://developer.gnome.org/documentation/guidelines/maintainer/integrating.html
  // https://www.electron.build/docs/linux/
  extraMetadata: {
    name: channel === "prod" ? "zaovra-desktop" : `zaovra-desktop-${channel}`,
    desktopName: `${appId}.desktop`,
    ...(channel === "beta"
      ? { zaovraChannel: "beta", zaovraUnsignedBeta: unsignedBeta, zaovraSourceSHA: process.env.BETA_SOURCE_SHA }
      : {}),
  },
  files: ["out/**/*", "!out/**/notices-inputs.json", "resources/**/*", "!resources/bin/**/*"],
  extraResources: process.platform === "win32" ? [{ from: "resources/bin", to: "bin" }] : [],
  mac: {
    category: "public.app-category.developer-tools",
    icon: `resources/icons/icon.icns`,
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: "resources/entitlements.plist",
    entitlementsInherit: "resources/entitlements.plist",
    notarize: true,
    target: ["dmg", "zip"],
  },
  dmg: {
    sign: true,
  },
  protocols: {
    name: "Zaovra",
    schemes: [DEEP_LINK_PROTOCOLS[channel]],
  },
  win: {
    icon: `resources/icons/icon.ico`,
    signtoolOptions: {
      sign: signWindows,
      ...(publisherName && !unsignedBeta ? { publisherName } : {}),
    },
    target: ["nsis"],
    verifyUpdateCodeSignature: !unsignedBeta,
  },
  nsis: {
    guid: INSTALLER_IDS[channel],
    include: `resources/channel-${channel}.nsh`,
    // Assisted (not one-click) so an existing per-machine install is upgraded in place
    // and the channel product name stays the default folder. channel-isolation.nsh
    // removes the install-mode and finish pages: only a progress page, then launch.
    oneClick: false,
    allowToChangeInstallationDirectory: false,
    runAfterFinish: true,
    perMachine: false,
    installerIcon: `resources/icons/icon.ico`,
    installerHeaderIcon: `resources/icons/icon.ico`,
    uninstallerIcon: `resources/icons/icon.ico`,
  },
  linux: {
    icon: `resources/icons`,
    category: "Development",
    executableName: appId,
    desktop: {
      entry: {
        // Match the installed .desktop file and hicolor icon basename so
        // Linux shells can associate the running Electron window with its launcher.
        StartupWMClass: appId,
      },
    },
    target: ["AppImage", "deb", "rpm"],
  },
})

export function getConfig(platform: NodeJS.Platform = process.platform) {
  const appId = APP_IDS[channel]
  const base = getBase(appId)
  const displayName = channel === "prod" ? "Zaovra" : channel === "beta" ? "Zaovra Beta" : "Zaovra Dev"
  // FPM places the application under /opt/<productName>. Keep its sandboxed
  // executable path free of spaces while retaining the human-facing launcher name.
  const productName = platform === "linux" ? (channel === "prod" ? "zaovra" : `zaovra-${channel}`) : displayName
  if (base.linux?.desktop?.entry) base.linux.desktop.entry.Name = displayName

  switch (channel) {
    case "dev": {
      return {
        ...base,
        appId,
        productName,
        rpm: { packageName: "zaovra-dev" },
      }
    }
    case "beta": {
      return {
        ...base,
        appId,
        productName,
        protocols: { name: "Zaovra Beta", schemes: [DEEP_LINK_PROTOCOLS[channel]] },
        publish: { provider: "generic", url: "https://updates.zaovra.com/beta/", channel: "beta" },
        rpm: { packageName: "zaovra-beta" },
      }
    }
    case "prod": {
      return {
        ...base,
        appId,
        productName,
        protocols: { name: "Zaovra", schemes: [DEEP_LINK_PROTOCOLS[channel]] },
        publish: { provider: "github", owner: "zuozizuozi", repo: "p-zaovra", channel: "latest" },
        deb: { fpm: [legacyDesktopEntryFpm] },
        rpm: { packageName: "zaovra", fpm: [legacyDesktopEntryFpm] },
      }
    }
  }
}

export default getConfig()
