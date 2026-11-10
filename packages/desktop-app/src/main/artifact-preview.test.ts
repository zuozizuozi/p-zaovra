import { afterEach, expect, mock, test } from "bun:test"
import { EventEmitter } from "node:events"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { WebContents } from "electron"

class PreviewContents extends EventEmitter {
  destroyed = false
  url = ""
  isDestroyed() {
    return this.destroyed
  }
  close() {
    this.destroyed = true
  }
  getURL() {
    return this.url
  }
  setWindowOpenHandler() {}
  setZoomFactor() {}
  async loadURL(url: string) {
    this.url = url
    this.emit("did-stop-loading")
  }
}

class PreviewView {
  webContents = new PreviewContents()
  constructor(readonly options: { webPreferences: { partition: string } }) {
    views.push(this)
  }
  setVisible() {}
  setBounds() {}
}

class PreviewSession extends EventEmitter {
  handlers = new Map<string, (request: Request & { initiatorOrigin?: string }) => Promise<Response>>()
  protocol = {
    isProtocolHandled: (scheme: string) => this.handlers.has(scheme),
    handle: (scheme: string, handler: (request: Request) => Promise<Response>) => {
      if (this.handlers.has(scheme)) throw new Error("Duplicate protocol handler")
      this.handlers.set(scheme, handler)
    },
  }
  setSpellCheckerEnabled() {}
  setSpellCheckerLanguages() {}
  setSpellCheckerDictionaryDownloadURL() {}
  setPermissionRequestHandler() {}
  setPermissionCheckHandler() {}
}

const views: PreviewView[] = []
const sessions = new Map<string, PreviewSession>()
const owners: EventEmitter[] = []
const directories: string[] = []
mock.module("electron", () => ({
  BrowserWindow: { fromWebContents: () => ({ contentView: { addChildView() {}, removeChildView() {} } }) },
  WebContentsView: PreviewView,
  session: {
    fromPartition(partition: string) {
      if (!sessions.has(partition)) sessions.set(partition, new PreviewSession())
      return sessions.get(partition)!
    },
  },
}))
const { createArtifactPreview } = await import("./artifact-preview")

function preview() {
  const owner = Object.assign(new EventEmitter(), {
    id: owners.length + 1,
    isDestroyed: () => false,
    getZoomFactor: () => 1,
  })
  owners.push(owner)
  return createArtifactPreview(owner as unknown as WebContents)
}

afterEach(async () => {
  for (const owner of owners.splice(0)) owner.emit("destroyed")
  for (const browsing of sessions.values()) expect(browsing.listenerCount("will-download")).toBe(0)
  sessions.clear()
  views.splice(0)
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

test("817 actual preview controller reopens edited files and replacement owner windows with the same origin and partition", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "zaovra-preview-reopen-"))
  directories.push(directory)
  await writeFile(path.join(directory, "index.html"), "first version")
  const api = preview()
  await api.open({ id: "first", target: "index.html", directory })
  const first = views[0]
  const url = first.webContents.url
  const partition = first.options.webPreferences.partition
  expect(url.startsWith("oc://artifact-")).toBe(true)
  expect(partition.startsWith("persist:artifact-")).toBe(true)
  await api.action({ id: "first", action: "close" })
  expect(first.webContents.isDestroyed()).toBe(true)
  await writeFile(path.join(directory, "index.html"), "edited version")
  await api.open({ id: "edited", target: "index.html", directory })
  expect(views[1].webContents.url).toBe(url)
  expect(views[1].options.webPreferences.partition).toBe(partition)
  expect(await (await sessions.get(partition)!.handlers.get("oc")!(new Request(url))).text()).toBe("edited version")
  owners[0].emit("destroyed")
  const replacement = preview()
  await replacement.open({ id: "replacement", target: "index.html", directory })
  expect(views[2].webContents.url).toBe(url)
  expect(views[2].options.webPreferences.partition).toBe(partition)
  expect(sessions.get(partition)!.handlers.size).toBe(1)
  expect(sessions.get(partition)!.listenerCount("will-download")).toBe(1)
})

test("817 preview project switches isolate persistent sessions, routes and navigation; remote previews retain their own session", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "zaovra-preview-projects-"))
  directories.push(directory)
  await mkdir(path.join(directory, "first"))
  await mkdir(path.join(directory, "second"))
  await writeFile(path.join(directory, "first", "index.html"), "first")
  await writeFile(path.join(directory, "second", "index.html"), "second")
  const api = preview()
  await api.open({ id: "first", target: "index.html", directory: path.join(directory, "first") })
  const first = views[0]
  await api.open({ id: "second", target: "index.html", directory: path.join(directory, "second") })
  const second = views[1]
  expect(first.webContents.isDestroyed()).toBe(true)
  expect(second.options.webPreferences.partition).not.toBe(first.options.webPreferences.partition)
  const handler = sessions.get(second.options.webPreferences.partition)!.handlers.get("oc")!
  expect((await handler(new Request(first.webContents.url))).status).toBe(403)
  expect(await (await handler(new Request(second.webContents.url))).text()).toBe("second")
  const blocked = {
    prevented: false,
    preventDefault() {
      this.prevented = true
    },
  }
  second.webContents.emit("will-navigate", blocked, first.webContents.url)
  expect(blocked.prevented).toBe(true)
  const allowed = {
    prevented: false,
    preventDefault() {
      this.prevented = true
    },
  }
  second.webContents.emit("will-navigate", allowed, new URL("/other.html", second.webContents.url).href)
  expect(allowed.prevented).toBe(false)
  await api.action({ id: "first", action: "close" })
  expect(second.webContents.isDestroyed()).toBe(false)
  await api.open({ id: "remote", target: "https://example.com/", directory })
  const remote = views[2]
  expect(remote.options.webPreferences.partition.startsWith("persist:")).toBe(false)
  expect(sessions.get(remote.options.webPreferences.partition)!.handlers.size).toBe(0)
  expect(remote.webContents.url).toBe("https://example.com/")
})
