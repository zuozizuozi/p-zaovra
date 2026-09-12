import { app, BrowserWindow, WebContentsView } from "electron"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises"
import { mkdtempSync, appendFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createArtifactPreview } from "../src/main/artifact-preview"

const log = (text: string) => appendFileSync(path.resolve("../../quality/artifact-native-smoke.txt"), text + "\n")
app.setPath("userData", mkdtempSync(path.join(tmpdir(), "zaovra-smoke-profile-")))
app.disableHardwareAcceleration()
app.on("window-all-closed", () => {})
setTimeout(() => { log("TIMEOUT"); app.exit(1) }, 30000)
log("starting")
void app.whenReady().then(async () => {
  log("ready")
  const directory = await mkdtemp(path.join(tmpdir(), "zaovra-preview-smoke-"))
  const window = new BrowserWindow({ width: 1000, height: 700, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  try {
    await writeFile(path.join(directory, "demo.html"), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="style.css"><h1>造物 · 成果预览</h1><p>这是独立浏览器中的真实 HTML。</p><button onclick="this.textContent=\'交互成功\'">点击验证</button>')
    await writeFile(path.join(directory, "style.css"), "body{font:18px system-ui;background:#15191f;color:#eee;padding:40px}button{padding:14px 24px;border-radius:8px;background:#4466ee;color:white;border:0}")
    log("loading host")
    await window.loadURL("data:text/html,<h1>Host</h1>")
    window.showInactive()
    log("host ready")
    const preview = createArtifactPreview(window.webContents)
    await preview.open({ id: "first", target: "demo.html", directory })
    log("preview requested")
    const guest = window.contentView.children.find((view) => view instanceof WebContentsView && view.webContents !== window.webContents)
    assert(guest instanceof WebContentsView)
    await new Promise<void>((resolve, reject) => {
      if (!guest.webContents.isLoading()) { resolve(); return }
      guest.webContents.once("did-finish-load", resolve)
      guest.webContents.once("did-fail-load", () => reject(new Error("Failed to load fixture")))
    })
    log("preview loaded")
    await preview.bounds({ id: "first", bounds: { x: 300, y: 60, width: 650, height: 600 }, visible: true })
    log("bounds ready")
    assert.equal(await guest.webContents.executeJavaScript("typeof window.api + ':' + typeof require"), "undefined:undefined")
    assert.equal(await guest.webContents.executeJavaScript("document.querySelector('button').click(); document.querySelector('button').textContent"), "交互成功")
    assert.equal(await guest.webContents.executeJavaScript("getComputedStyle(document.body).backgroundColor"), "rgb(21, 25, 31)")
    await preview.bounds({ id: "first", bounds: { x: 300, y: 60, width: 650, height: 600 }, visible: true })
    assert.equal(guest.getBounds().width, 650)
    await preview.action({ id: "first", action: "zoom-in" })
    assert.equal((await preview.state("first"))?.zoom, 1.1)
    await writeFile(path.resolve("../../quality/artifact-native-preview.png"), (await guest.webContents.capturePage()).toPNG())
    await preview.action({ id: "stale", action: "close" })
    assert(await preview.state("first"))
    const contents = guest.webContents
    const destroyed = new Promise<void>((resolve) => contents.once("destroyed", resolve))
    await preview.action({ id: "first", action: "close" })
    await destroyed
    assert.equal(await preview.state("first"), undefined)
    assert(contents.isDestroyed())
    await writeFile(path.join(directory, "scan.pdf"), await readFile("resources/attachments/fixtures/scan.pdf"))
    const bytes = await preview.readPDF({ target: "scan.pdf", directory })
    assert.equal(new TextDecoder().decode(bytes.slice(0, 4)), "%PDF")
    log("ARTIFACT_NATIVE_PASS: HTML, relative CSS, interaction, isolation, bounds, zoom, stale close, cleanup")
  } finally {
    window.destroy()
    await rm(directory, { recursive: true, force: true })
  }
  app.exit(0)
}).catch((error) => { log(String(error)); app.exit(1) })
