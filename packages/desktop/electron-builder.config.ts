import { execFile } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import type { Configuration } from "electron-builder"

const execFileAsync = promisify(execFile)
const packageDir = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(packageDir, "../..")
const signScript = path.join(rootDir, "script", "sign-windows.ps1")
// Keep the short desktop entry as an installation compatibility alias so existing
// GNOME/KDE pins continue to resolve alongside the canonical Zaovra app id.
const legacyDesktopEntry = path.join(packageDir, "resources", "linux", "zaovra-desktop.desktop")
const legacyDesktopEntryFpm = `${legacyDesktopEntry.replaceAll("\\", "/")}=/usr/share/applications/zaovra-desktop.desktop`

async function signWindows(configuration: { path: string }) {
  if (process.platform !== "win32") return
  if (process.env.GITHUB_ACTIONS !== "true") return

  await execFileAsync(
    "pwsh",
    ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", signScript, configuration.path],
    { cwd: rootDir },
  )
}

const channel = (() => {
  const raw = process.env.ZAOVRA_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  return "dev"
})()

const APP_IDS = {
  dev: "ai.zaovra.desktop.dev",
  beta: "ai.zaovra.desktop.beta",
  prod: "ai.zaovra.desktop",
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
    desktopName: `${appId}.desktop`,
  },
  files: ["out/**/*", "resources/**/*"],
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
    schemes: ["zaovra"],
  },
  win: {
    icon: `resources/icons/icon.ico`,
    signtoolOptions: {
      sign: signWindows,
    },
    target: ["nsis"],
    verifyUpdateCodeSignature: false,
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    installerIcon: `resources/icons/icon.ico`,
    installerHeaderIcon: `resources/icons/icon.ico`,
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

function getConfig() {
  const appId = APP_IDS[channel]
  const base = getBase(appId)

  switch (channel) {
    case "dev": {
      return {
        ...base,
        appId,
        productName: "Zaovra Dev",
        rpm: { packageName: "zaovra-dev" },
      }
    }
    case "beta": {
      return {
        ...base,
        appId,
        productName: "Zaovra Beta",
        protocols: { name: "Zaovra Beta", schemes: ["zaovra"] },
        publish: { provider: "github", owner: "zuozizuozi", repo: "p-zaovra", channel: "beta" },
        rpm: { packageName: "zaovra-beta" },
      }
    }
    case "prod": {
      return {
        ...base,
        appId,
        productName: "Zaovra",
        protocols: { name: "Zaovra", schemes: ["zaovra"] },
        publish: { provider: "github", owner: "zuozizuozi", repo: "p-zaovra", channel: "latest" },
        deb: { fpm: [legacyDesktopEntryFpm] },
        rpm: { packageName: "zaovra", fpm: [legacyDesktopEntryFpm] },
      }
    }
  }
}

export default getConfig()
