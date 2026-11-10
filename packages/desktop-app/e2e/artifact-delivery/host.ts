import { app, BrowserWindow } from "electron"
import path from "node:path"
import fs from "node:fs/promises"
import { registerIpcHandlers } from "../../src/main/ipc"
import { createUpdaterController } from "../../src/main/updater-controller"

const root = process.env.QA_ARTIFACT_HOST_ROOT
if (!root || !path.resolve(root).startsWith(path.resolve("F:/Zaovra-研发记录") + path.sep))
  throw new Error("An isolated records directory is required")
app.setPath("userData", path.join(root, "profile"))
app.setPath("logs", path.join(root, "logs"))
app.disableHardwareAcceleration()
app.on("window-all-closed", () => app.quit())
await fs.mkdir(root, { recursive: true })
await app.whenReady()
registerIpcHandlers({
  localServerExit: () => null,
  killSidecar: () => {},
  relaunch: () => app.quit(),
  awaitInitialization: async () => ({ url: "http://127.0.0.1:4563", username: null, password: null }),
  consumeInitialDeepLinks: () => [],
  getDefaultServerUrl: () => "http://127.0.0.1:4563",
  setDefaultServerUrl: () => {},
  isFirstLaunchOnboardingPending: () => false,
  finishFirstLaunchOnboarding: () => null,
  isOldLayoutEligible: () => true,
  getDisplayBackend: () => null,
  setDisplayBackend: () => {},
  parseMarkdown: (value) => value,
  checkAppExists: () => false,
  resolveAppPath: async () => null,
  updater: createUpdaterController({
    enabled: false,
    currentVersion: "0.0.0",
    backend: { checkForUpdates: async () => null, downloadUpdate: async () => {}, quitAndInstall: () => {} },
    persistence: { get: () => undefined, set: () => {}, clear: () => {} },
  }),
  showUpdater: () => {},
  setBackgroundColor: () => {},
  exportDebugLogs: async () => root,
  recordFatalRendererError: (error) =>
    fs.appendFile(path.join(root, "renderer-errors.jsonl"), JSON.stringify(error) + "\n"),
})
const window = new BrowserWindow({
  title: "Zaovra 792 isolated acceptance",
  width: 1440,
  height: 1000,
  show: false,
  webPreferences: {
    preload: process.env.QA_ARTIFACT_HOST_PRELOAD,
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
  },
})
await window.loadURL("http://127.0.0.1:4566")
await fs.writeFile(
  path.join(root, "ready.json"),
  JSON.stringify({ pid: process.pid, url: window.webContents.getURL() }),
)
