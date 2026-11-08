import { app, BrowserWindow, ipcMain } from "electron"
import { readFileSync, appendFileSync, mkdirSync } from "node:fs"
import { resolve, dirname, relative, isAbsolute } from "node:path"
import { createRequire } from "node:module"

const options = JSON.parse(
  readFileSync(
    process.argv.find((value) => value.endsWith("host-options.json")),
    "utf8",
  ),
)
const inside = relative(resolve(options.root), resolve(options.profile))
if (inside.startsWith("..") || isAbsolute(inside)) throw Error("isolated profile required")
mkdirSync(options.profile, { recursive: true })
app.setPath("userData", options.profile)
const require = createRequire(import.meta.url)
// Electron waits for ESM entry evaluation before readiness.
app
  .whenReady()
  .then(async () => {
    const { getStore, writeStore } = require(options.storageBundle)
    const log = (value) =>
      appendFileSync(options.journal, JSON.stringify({ at: new Date().toISOString(), ...value }) + "\n")
    getStore("zaovra.global.dat").set("language", JSON.stringify({ locale: options.locale ?? "en" }))
    getStore("default.dat").set(
      "highlights.v1",
      JSON.stringify({ version: options.previousVersion ?? "0.1.1-beta.16" }),
    )
    const handlers = {
      "get-window-id": () => "verify749",
      "get-window-count": () => 1,
      "await-initialization": () => ({ url: options.origin }),
      "local-server-exit": () => null,
      "get-default-server-url": () => "sidecar",
      "set-default-server-url": () => undefined,
      "is-first-launch-onboarding-pending": () => false,
      "is-old-layout-eligible": () => false,
      "finish-first-launch-onboarding": (_event, create) => (create ? { directory: options.directory } : null),
      "get-display-backend": () => "auto",
      "get-pinch-zoom-enabled": () => false,
      "get-zoom-factor": () => 1,
      "get-window-focused": () => true,
      "set-window-focus": () => undefined,
      "show-window": () => undefined,
      "set-background-color": () => undefined,
      "set-titlebar": () => undefined,
      "updater-auto-get": () => false,
      "updater-subscribe": () => undefined,
      "updater-unsubscribe": () => undefined,
      "consume-initial-deep-links": () => [],
      "wsl-servers-get-state": () => ({
        runtime: null,
        installed: [],
        online: [],
        distroProbes: {},
        zaovraChecks: {},
        pendingRestart: false,
        servers: [],
        job: null,
      }),
      "wsl-servers-subscribe": () => undefined,
      "wsl-servers-unsubscribe": () => undefined,
      "store-get": (_event, name, key) => getStore(name).get(key),
      "store-set": async (event, name, key, value) => {
        await writeStore(
          name,
          key,
          value,
          event.sender.id,
          BrowserWindow.getAllWindows().map((window) => window.webContents),
        )
        log({ operation: "store-set", name, key, bytes: Buffer.byteLength(value) })
      },
      "store-delete": (_event, name, key) => getStore(name).delete(key),
      "store-clear": (_event, name) => getStore(name).clear(),
      "store-keys": (_event, name) => Object.keys(getStore(name).store),
      "store-length": (_event, name) => Object.keys(getStore(name).store).length,
      "record-fatal-renderer-error": (_event, error) => log({ operation: "fatal-renderer", error }),
    }
    for (const [name, handler] of Object.entries(handlers)) ipcMain.handle(name, handler)
    ipcMain.on("open-link", (_event, url) => log({ operation: "blocked-open-link", url }))
    ipcMain.on("show-notification", () => log({ operation: "notification-request" }))
    const window = new BrowserWindow({
      width: 1400,
      height: 900,
      show: true,
      webPreferences: { preload: options.preload, contextIsolation: true, nodeIntegration: false, sandbox: false },
    })
    window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
      const url = new URL(details.url)
      const allowed = ["about:", "devtools:", "data:", "blob:"].includes(url.protocol) || url.origin === options.origin
      if (!allowed) log({ operation: "blocked-external-request", url: url.origin })
      callback({ cancel: !allowed })
    })
    window.webContents.on("render-process-gone", (_event, details) => log({ operation: "renderer-gone", details }))
    window.on("closed", () => app.quit())
    await window.loadURL("about:blank")
    log({
      operation: "ready",
      version: app.getVersion(),
      packaged: app.isPackaged,
      electron: process.versions.electron,
      node: process.versions.node,
      profile: app.getPath("userData"),
    })
  })
  .catch((error) => {
    appendFileSync(options.journal, JSON.stringify({ startupError: String(error), stack: error.stack }) + "\n")
    app.quit()
  })
