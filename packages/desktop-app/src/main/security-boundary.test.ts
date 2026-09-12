import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test"
import type { Session, WebContents } from "electron"

const originalRendererUrl = process.env.ELECTRON_RENDERER_URL
const invokeHandlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
const eventHandlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
const externalUrls: string[] = []
const openedPaths: string[] = []

mock.module("electron", () => {
  const app = {
    isPackaged: false,
    dock: undefined,
    getPath: () => "C:\\zaovra-test",
    once: () => undefined,
    relaunch: () => undefined,
    exit: () => undefined,
    quit: () => undefined,
  }
  const electron = {
    app,
    BrowserWindow: class {},
    Notification: class {},
    clipboard: {},
    crashReporter: { start: () => undefined },
    dialog: {},
    ipcMain: {
      handle: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) =>
        invokeHandlers.set(channel, listener),
      on: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) =>
        eventHandlers.set(channel, listener),
    },
    nativeImage: {},
    nativeTheme: { shouldUseDarkColors: false },
    net: {},
    netLog: { currentlyLogging: false },
    protocol: { registerSchemesAsPrivileged: () => undefined },
    shell: {
      openExternal: (url: string) => {
        externalUrls.push(url)
        return Promise.resolve()
      },
      openPath: (path: string) => {
        openedPaths.push(path)
        return Promise.resolve("")
      },
    },
  }
  return { ...electron, default: electron }
})

const windows = await import("./windows")
const ipc = await import("./ipc")

beforeAll(() => {
  delete process.env.ELECTRON_RENDERER_URL
})

afterAll(() => {
  if (originalRendererUrl === undefined) delete process.env.ELECTRON_RENDERER_URL
  if (originalRendererUrl !== undefined) process.env.ELECTRON_RENDERER_URL = originalRendererUrl
})

describe("desktop renderer trust boundary", () => {
  test("shared permission handlers retain all live trusted windows", () => {
    const handlers: {
      request?: Parameters<Session["setPermissionRequestHandler"]>[0]
      check?: Parameters<Session["setPermissionCheckHandler"]>[0]
    } = {}
    const session = {
      setPermissionRequestHandler: (handler: typeof handlers.request) => { handlers.request = handler },
      setPermissionCheckHandler: (handler: typeof handlers.check) => { handlers.check = handler },
    }
    const closed = new Set<number>()
    const first = { id: 1, session, isDestroyed: () => closed.has(1) } as unknown as WebContents
    const second = { id: 2, session, isDestroyed: () => closed.has(2) } as unknown as WebContents
    const foreign = { id: 3, session, isDestroyed: () => false } as unknown as WebContents
    windows.allowRendererPermissions({ webContents: first })
    const initial = handlers.check
    windows.allowRendererPermissions({ webContents: second })
    expect(handlers.check).toBe(initial)
    const details = { requestingUrl: "oc://renderer/index.html", isMainFrame: true }
    expect(handlers.check!(first, "notifications", "oc://renderer", details)).toBe(true)
    expect(handlers.check!(second, "clipboard-sanitized-write", "oc://renderer", details)).toBe(true)
    closed.add(2)
    expect(handlers.check!(first, "notifications", "oc://renderer", details)).toBe(true)
    expect(handlers.check!(second, "notifications", "oc://renderer", details)).toBe(false)
    expect(handlers.check!(foreign, "notifications", "oc://renderer", details)).toBe(false)
    expect(handlers.check!(null, "notifications", "oc://renderer", details)).toBe(false)
    const replies: boolean[] = []
    handlers.request!(first, "notifications", (allowed) => replies.push(allowed), details)
    handlers.request!(first, "notifications", (allowed) => replies.push(allowed), { ...details, requestingUrl: "https://example.com" })
    expect(replies).toEqual([true, false])
  })

  test("allows only the packaged renderer origin", () => {
    expect(windows.isTrustedRendererUrl("oc://renderer/index.html")).toBe(true)
    expect(windows.isTrustedRendererUrl("oc://renderer/assets/index.js")).toBe(true)
    expect(windows.isTrustedRendererUrl("oc://attacker/index.html")).toBe(false)
    expect(windows.isTrustedRendererUrl("https://example.com")).toBe(false)
  })

  test("uses the explicit development origin without trusting sibling origins", () => {
    process.env.ELECTRON_RENDERER_URL = "http://127.0.0.1:5173/app/"
    expect(windows.isTrustedRendererUrl("http://127.0.0.1:5173/index.html")).toBe(true)
    expect(windows.isTrustedRendererUrl("http://127.0.0.1:5174/index.html")).toBe(false)
    expect(windows.isTrustedRendererUrl("http://localhost:5173/index.html")).toBe(false)
    delete process.env.ELECTRON_RENDERER_URL
  })

  test("externalizes only safe protocols and denies all other navigation", () => {
    expect(windows.rendererNavigationDisposition("oc://renderer/index.html")).toBe("allow")
    expect(windows.rendererNavigationDisposition("https://example.com/path")).toBe("external")
    expect(windows.rendererNavigationDisposition("mailto:support@zaovra.com")).toBe("external")
    expect(windows.rendererNavigationDisposition("file:///C:/Windows/System32/calc.exe")).toBe("deny")
    expect(windows.rendererNavigationDisposition("javascript:alert(1)")).toBe("deny")
    expect(windows.rendererNavigationDisposition("zaovra://session/1")).toBe("deny")
  })

  test("requires IPC from the trusted main frame", () => {
    const mainFrame = { url: "oc://renderer/index.html" }
    expect(ipc.isTrustedIpcSender({ sender: { mainFrame }, senderFrame: mainFrame } as never)).toBe(true)
    expect(
      ipc.isTrustedIpcSender({
        sender: { mainFrame },
        senderFrame: { url: "https://example.com/frame" },
      } as never),
    ).toBe(false)
    expect(
      ipc.isTrustedIpcSender({
        sender: { mainFrame },
        senderFrame: { url: "oc://renderer/child.html" },
      } as never),
    ).toBe(false)
  })

  test("limits explicit application launches to the product allowlist", () => {
    expect(ipc.isAllowedOpenApp("Visual Studio Code")).toBe(true)
    expect(ipc.isAllowedOpenApp("cursor")).toBe(true)
    expect(ipc.isAllowedOpenApp("C:\\Windows\\System32\\cmd.exe")).toBe(false)
    expect(ipc.isAllowedOpenApp("/bin/sh")).toBe(false)
  })

  test("guards every registered IPC entrypoint and limits external opening", async () => {
    invokeHandlers.clear()
    eventHandlers.clear()
    externalUrls.length = 0
    openedPaths.length = 0
    ipc.registerIpcHandlers({
      killSidecar: () => undefined,
      relaunch: () => undefined,
      awaitInitialization: () => Promise.resolve({ url: "http://127.0.0.1", username: null, password: null }),
      consumeInitialDeepLinks: () => [],
      getDefaultServerUrl: () => null,
      setDefaultServerUrl: () => undefined,
      isFirstLaunchOnboardingPending: () => false,
      finishFirstLaunchOnboarding: () => null,
      isOldLayoutEligible: () => false,
      getDisplayBackend: () => Promise.resolve(null),
      setDisplayBackend: () => undefined,
      parseMarkdown: (markdown: string) => markdown,
      checkAppExists: () => true,
      resolveAppPath: () => Promise.resolve(null),
      updater: {
        subscribe: () => () => undefined,
        check: () => Promise.resolve({ status: "idle" }),
        install: () => Promise.resolve(),
      },
      showUpdater: () => undefined,
      setBackgroundColor: () => undefined,
      exportDebugLogs: () => Promise.resolve("logs.zip"),
      recordFatalRendererError: () => undefined,
    } as never)

    const mainFrame = { url: "oc://renderer/index.html" }
    const trusted = { sender: { id: 1, mainFrame }, senderFrame: mainFrame }
    const remoteFrame = { url: "https://example.com" }
    const untrusted = { sender: { id: 2, mainFrame: remoteFrame }, senderFrame: remoteFrame }
    expect(() => invokeHandlers.get("await-initialization")!(untrusted)).toThrow("Untrusted IPC sender")
    expect(await invokeHandlers.get("open-path")!(trusted, process.cwd())).toBe("")
    await expect(invokeHandlers.get("open-path")!(trusted, import.meta.path)).rejects.toThrow(
      "Only directories can be opened",
    )
    eventHandlers.get("open-link")!(trusted, "file:///C:/Windows/System32/calc.exe")
    eventHandlers.get("open-link")!(trusted, "https://zaovra.com")
    eventHandlers.get("open-link")!(untrusted, "https://example.com")
    expect(openedPaths).toEqual([process.cwd()])
    expect(externalUrls).toEqual(["https://zaovra.com"])
  })
})
