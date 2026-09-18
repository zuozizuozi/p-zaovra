import { createArtifactPreview } from "./artifact-preview"
import type { ArtifactPreviewAPI } from "@zaovra-ai/app/artifact-preview"
import { execFile } from "node:child_process"
import { discoverProviderModels, type ProviderDiscoveryInput } from "@zaovra-ai/app/provider-discovery"
import { stat } from "node:fs/promises"
import { basename, join } from "node:path"
import { convertAttachment } from "./attachment-convert"
import { app, BrowserWindow, Notification, clipboard, dialog, ipcMain, shell } from "electron"
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron"
import type { DesktopMenuAction } from "@zaovra-ai/app/desktop-menu"

import type { FatalRendererError, LinuxDisplayBackend, ServerReadyData, TitlebarTheme } from "../preload/types"
import { runDesktopMenuAction } from "./desktop-menu-actions"
import { setForceFocus } from "./debug"
import { assertAttachmentBudget, createPickedFileAuthorizations } from "./attachment-picker"
import { getStore, removeStoreFileIfEmpty } from "./store"
import { writeStore } from "./store-write"
import {
  getPinchZoomEnabled,
  getWindowID,
  isAllowedExternalUrl,
  isTrustedRendererUrl,
  setPinchZoomEnabled,
  setTitlebar,
  updateTitlebar,
} from "./windows"
import type { UpdaterController } from "./updater-controller"
import { createUpdaterSubscriptions } from "./updater-subscriptions"

const pickerFilters = (ext?: string[]) => {
  if (!ext || ext.length === 0) return undefined
  return [{ name: "Files", extensions: ext }]
}

const pickedFiles = createPickedFileAuthorizations()
const allowedOpenApps = new Set([
  "Visual Studio Code",
  "Cursor",
  "Zed",
  "TextMate",
  "Antigravity",
  "Terminal",
  "iTerm",
  "Ghostty",
  "Warp",
  "Xcode",
  "Android Studio",
  "Sublime Text",
  "code",
  "cursor",
  "zed",
  "powershell",
])

export function isAllowedOpenApp(value: string) {
  return allowedOpenApps.has(value)
}

export function isTrustedIpcSender(event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">) {
  return event.senderFrame === event.sender.mainFrame && isTrustedRendererUrl(event.senderFrame?.url)
}

type Deps = {
  localServerExit: () => number | null
  killSidecar: () => Promise<void> | void
  relaunch: () => void
  awaitInitialization: () => Promise<ServerReadyData>
  consumeInitialDeepLinks: () => Promise<string[]> | string[]
  getDefaultServerUrl: () => Promise<string | null> | string | null
  setDefaultServerUrl: (url: string | null) => Promise<void> | void
  isFirstLaunchOnboardingPending: () => Promise<boolean> | boolean
  finishFirstLaunchOnboarding: (createDefaultProject: boolean) => Promise<string | null> | string | null
  isOldLayoutEligible: () => Promise<boolean> | boolean
  getDisplayBackend: () => Promise<LinuxDisplayBackend | null>
  setDisplayBackend: (backend: LinuxDisplayBackend | null) => Promise<void> | void
  parseMarkdown: (markdown: string) => Promise<string> | string
  checkAppExists: (appName: string) => Promise<boolean> | boolean
  resolveAppPath: (appName: string) => Promise<string | null>
  updater: UpdaterController
  showUpdater: () => Promise<void> | void
  setBackgroundColor: (color: string) => void
  exportDebugLogs: () => Promise<string>
  recordFatalRendererError: (error: FatalRendererError) => Promise<void> | void
}

export function registerIpcHandlers(deps: Deps) {
  const conversions = new Map<number, { id: string; controller: AbortController }>()
  const updaterSubscriptions = createUpdaterSubscriptions()
  const resolvedApps = new Map<number, Set<string>>()
  const handle = <Args extends unknown[], Result>(
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: Args) => Result,
  ) =>
    ipcMain.handle(channel, (event, ...args) => {
      if (!isTrustedIpcSender(event)) throw new Error("Untrusted IPC sender")
      return listener(event, ...(args as Args))
    })
  const on = <Args extends unknown[]>(channel: string, listener: (event: IpcMainEvent, ...args: Args) => void) =>
    ipcMain.on(channel, (event, ...args) => {
      if (!isTrustedIpcSender(event)) return
      listener(event, ...(args as Args))
    })
  const previews = new Map<number, ArtifactPreviewAPI>()
  const preview = (event: IpcMainInvokeEvent) => {
    const existing = previews.get(event.sender.id)
    if (existing) return existing
    const value = createArtifactPreview(event.sender)
    previews.set(event.sender.id, value)
    event.sender.once("destroyed", () => previews.delete(event.sender.id))
    return value
  }
  handle("artifact-read-pdf", (event, input: Parameters<ArtifactPreviewAPI["readPDF"]>[0]) =>
    preview(event).readPDF(input),
  )
  handle("artifact-open", (event, input: Parameters<ArtifactPreviewAPI["open"]>[0]) => preview(event).open(input))
  handle("artifact-bounds", (event, input: Parameters<ArtifactPreviewAPI["bounds"]>[0]) => preview(event).bounds(input))
  handle("artifact-action", (event, input: Parameters<ArtifactPreviewAPI["action"]>[0]) => preview(event).action(input))
  handle("artifact-state", (event, id: string) => preview(event).state(id))
  const rememberResolvedApp = (event: IpcMainInvokeEvent, value: string) => {
    const current = resolvedApps.get(event.sender.id)
    if (current) {
      current.add(value.toLowerCase())
      return
    }
    resolvedApps.set(event.sender.id, new Set([value.toLowerCase()]))
    event.sender.once("destroyed", () => resolvedApps.delete(event.sender.id))
  }
  handle("cancel-attachment", (event, id: string) => {
    const task = conversions.get(event.sender.id)
    if (task?.id !== id) return
    task.controller.abort()
    conversions.delete(event.sender.id)
  })
  handle("convert-attachment", async (event, input: { id: string; name: string; bytes: ArrayBuffer }) => {
    if (conversions.has(event.sender.id)) throw new Error("正在解析附件，请等待当前文件完成后重试")
    const controller = new AbortController()
    conversions.set(event.sender.id, { id: input.id, controller })
    const destroyed = () => controller.abort()
    event.sender.once("destroyed", destroyed)
    const runtime = app.isPackaged
      ? join(process.resourcesPath, "attachments")
      : join(app.getAppPath(), "../../.cache/attachment-python")
    try {
      return await convertAttachment(
        input,
        {
          python: join(runtime, process.platform === "win32" ? "Scripts/python.exe" : "bin/python"),
          script: join(
            app.isPackaged ? process.resourcesPath : join(app.getAppPath(), "resources"),
            "attachments/convert.py",
          ),
          models: join(runtime, "models"),
        },
        controller.signal,
      )
    } finally {
      event.sender.removeListener("destroyed", destroyed)
      if (conversions.get(event.sender.id)?.id === input.id) conversions.delete(event.sender.id)
    }
  })
  app.once("will-quit", updaterSubscriptions.clear)

  handle("kill-sidecar", () => deps.killSidecar())
  handle("await-initialization", () => deps.awaitInitialization())
  handle("local-server-exit", () => deps.localServerExit())
  handle("consume-initial-deep-links", () => deps.consumeInitialDeepLinks())
  handle("get-default-server-url", () => deps.getDefaultServerUrl())
  handle("set-default-server-url", (_event: IpcMainInvokeEvent, url: string | null) => deps.setDefaultServerUrl(url))
  handle("is-first-launch-onboarding-pending", () => deps.isFirstLaunchOnboardingPending())
  handle("finish-first-launch-onboarding", (_event: IpcMainInvokeEvent, createDefaultProject: boolean) =>
    deps.finishFirstLaunchOnboarding(createDefaultProject),
  )
  handle("is-old-layout-eligible", () => deps.isOldLayoutEligible())
  handle("get-display-backend", () => deps.getDisplayBackend())
  handle("set-display-backend", (_event: IpcMainInvokeEvent, backend: string | null) => {
    if (backend !== null && backend !== "auto" && backend !== "wayland") throw new Error("Invalid display backend")
    return deps.setDisplayBackend(backend)
  })
  handle("parse-markdown", (_event: IpcMainInvokeEvent, markdown: string) => deps.parseMarkdown(markdown))
  handle("provider-discover-models", (_event: IpcMainInvokeEvent, input: ProviderDiscoveryInput) =>
    discoverProviderModels(input),
  )
  handle("check-app-exists", (_event: IpcMainInvokeEvent, appName: string) =>
    isAllowedOpenApp(appName) ? deps.checkAppExists(appName) : false,
  )
  handle("resolve-app-path", async (event: IpcMainInvokeEvent, appName: string) => {
    if (!isAllowedOpenApp(appName)) return null
    const resolved = await deps.resolveAppPath(appName)
    if (resolved) rememberResolvedApp(event, resolved)
    return resolved
  })
  handle("updater-subscribe", (event) => {
    const id = event.sender.id
    updaterSubscriptions.set(
      id,
      deps.updater.subscribe((state) => {
        if (event.sender.isDestroyed()) return updaterSubscriptions.delete(id)
        event.sender.send("updater-state", state)
      }),
    )
    event.sender.once("destroyed", () => updaterSubscriptions.delete(id))
  })
  handle("updater-unsubscribe", (event) => updaterSubscriptions.delete(event.sender.id))
  handle("updater-check", () => deps.updater.check())
  handle("updater-install", () => deps.updater.install())
  handle("set-background-color", (_event: IpcMainInvokeEvent, color: string) => deps.setBackgroundColor(color))
  handle("export-debug-logs", () => deps.exportDebugLogs())
  handle("set-force-focus", (event: IpcMainInvokeEvent, enabled: boolean) => setForceFocus(event.sender, enabled))
  handle("record-fatal-renderer-error", (_event: IpcMainInvokeEvent, error: FatalRendererError) =>
    deps.recordFatalRendererError(error),
  )
  handle("store-get", (_event: IpcMainInvokeEvent, name: string, key: string) => {
    try {
      const store = getStore(name)
      const value = store.get(key)
      if (value === undefined || value === null) return null
      return typeof value === "string" ? value : JSON.stringify(value)
    } catch {
      return null
    }
  })
  handle("store-set", (event: IpcMainInvokeEvent, name: string, key: string, value: string) => {
    writeStore(
      name,
      key,
      value,
      event.sender.id,
      BrowserWindow.getAllWindows()
        .map((win) => win.webContents)
        .filter((contents) => !contents.isDestroyed() && isTrustedRendererUrl(contents.getURL())),
    )
  })
  handle("store-delete", (_event: IpcMainInvokeEvent, name: string, key: string) => {
    getStore(name).delete(key)
    void removeStoreFileIfEmpty(name)
  })
  handle("store-clear", (_event: IpcMainInvokeEvent, name: string) => {
    getStore(name).clear()
    void removeStoreFileIfEmpty(name)
  })
  handle("store-keys", (_event: IpcMainInvokeEvent, name: string) => {
    const store = getStore(name)
    return Object.keys(store.store)
  })
  handle("store-length", (_event: IpcMainInvokeEvent, name: string) => {
    const store = getStore(name)
    return Object.keys(store.store).length
  })

  handle(
    "open-directory-picker",
    async (_event: IpcMainInvokeEvent, opts?: { multiple?: boolean; title?: string; defaultPath?: string }) => {
      const result = await dialog.showOpenDialog({
        properties: ["openDirectory", ...(opts?.multiple ? ["multiSelections" as const] : []), "createDirectory"],
        title: opts?.title ?? "Choose a folder",
        defaultPath: opts?.defaultPath,
      })
      if (result.canceled) return null
      return opts?.multiple ? result.filePaths : result.filePaths[0]
    },
  )

  handle(
    "open-file-picker",
    async (
      event: IpcMainInvokeEvent,
      opts?: { multiple?: boolean; title?: string; defaultPath?: string; extensions?: string[] },
    ) => {
      const result = await dialog.showOpenDialog({
        properties: ["openFile", ...(opts?.multiple ? ["multiSelections" as const] : [])],
        title: opts?.title ?? "Choose a file",
        defaultPath: opts?.defaultPath,
        filters: pickerFilters(opts?.extensions),
      })
      if (result.canceled) return null
      const files = await Promise.all(
        result.filePaths.map(async (filePath) => ({
          path: filePath,
          name: basename(filePath),
          size: (await stat(filePath)).size,
        })),
      )
      assertAttachmentBudget(files)
      const token = pickedFiles.add(event.sender.id, result.filePaths)
      return { token, files }
    },
  )

  handle("read-picked-file", async (event: IpcMainInvokeEvent, token: string, filePath: string) => {
    return pickedFiles.read(event.sender.id, token, filePath)
  })

  handle("release-picked-files", (event: IpcMainInvokeEvent, token: string) => {
    pickedFiles.release(event.sender.id, token)
  })

  handle("save-file-picker", async (_event: IpcMainInvokeEvent, opts?: { title?: string; defaultPath?: string }) => {
    const result = await dialog.showSaveDialog({
      title: opts?.title ?? "Save file",
      defaultPath: opts?.defaultPath,
    })
    if (result.canceled) return null
    return result.filePath ?? null
  })

  on("open-link", (_event: IpcMainEvent, url: string) => {
    if (isAllowedExternalUrl(url)) void shell.openExternal(url)
  })

  handle("open-path", async (event: IpcMainInvokeEvent, path: string, app?: string) => {
    if (!(await stat(path)).isDirectory()) throw new Error("Only directories can be opened")
    if (!app) return shell.openPath(path)
    const approved =
      process.platform === "win32"
        ? resolvedApps.get(event.sender.id)?.has(app.toLowerCase()) === true
        : isAllowedOpenApp(app)
    if (!approved) throw new Error("Application is not approved")
    await new Promise<void>((resolve, reject) => {
      const [cmd, args] =
        process.platform === "darwin" ? (["open", ["-a", app, path]] as const) : ([app, [path]] as const)
      execFile(cmd, args, (err) => (err ? reject(err) : resolve()))
    })
  })

  handle("reveal-path", async (_event: IpcMainInvokeEvent, path: string) => {
    const exists = await stat(path).then(
      () => true,
      () => false,
    )
    if (!exists) return false
    shell.showItemInFolder(path)
    return true
  })

  handle("read-clipboard-image", () => {
    const image = clipboard.readImage()
    if (image.isEmpty()) return null
    const buffer = image.toPNG().buffer
    const size = image.getSize()
    return { buffer, width: size.width, height: size.height }
  })

  on("show-notification", (_event: IpcMainEvent, title: string, body?: string) => {
    new Notification({ title, body }).show()
  })

  handle("get-window-count", () => BrowserWindow.getAllWindows().length)

  handle("get-window-id", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) throw new Error("Window not found")
    const id = getWindowID(win)
    if (!id) throw new Error("Window ID not found")
    return id
  })

  handle("get-window-focused", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return win?.isFocused() ?? false
  })

  handle("set-window-focus", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    win?.focus()
  })

  handle("show-window", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    win?.show()
  })

  on("relaunch", () => {
    deps.relaunch()
  })

  handle("get-zoom-factor", (event: IpcMainInvokeEvent) => event.sender.getZoomFactor())
  handle("set-zoom-factor", (event: IpcMainInvokeEvent, factor: number) => {
    event.sender.setZoomFactor(factor)
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    updateTitlebar(win)
  })
  handle("get-pinch-zoom-enabled", () => getPinchZoomEnabled())
  handle("set-pinch-zoom-enabled", (_event: IpcMainInvokeEvent, enabled: boolean) => {
    setPinchZoomEnabled(enabled)
  })
  handle("set-titlebar", (event: IpcMainInvokeEvent, theme: TitlebarTheme) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    setTitlebar(win, theme)
  })
  handle("run-desktop-menu-action", (event: IpcMainInvokeEvent, action: DesktopMenuAction) => {
    runDesktopMenuAction(BrowserWindow.fromWebContents(event.sender), action, {
      checkForUpdates: () => void deps.showUpdater(),
      relaunch: deps.relaunch,
    })
  })
}

export function sendMenuCommand(win: BrowserWindow, id: string) {
  win.webContents.send("menu-command", id)
}

export function sendDeepLinks(win: BrowserWindow, urls: string[]) {
  win.webContents.send("deep-link", urls)
}

export function sendLocalServerExit(code: number) {
  BrowserWindow.getAllWindows().forEach((win) => {
    if (!win.webContents.isDestroyed()) win.webContents.send("local-server-exit", code)
  })
}
