import { app, BrowserWindow, ipcMain, net, protocol } from "electron"
import { createServer } from "node:http"
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { isTrustedIpcSender } from "../src/main/ipc"
import { submitFeedback } from "../src/main/feedback"

const root = process.env.ZAOVRA_BRIDGE_FIXTURE!
if (!root) throw new Error("Explicit fixture directory required")
app.setPath("userData", join(root, "profile"))
app.setPath("sessionData", join(root, "session"))
const windows: BrowserWindow[] = []
const result = {
  visibleWindows: 0,
  remotePosts: 0,
  loopbackPosts: 0,
  trustedCalls: 0,
  rejectedOrigins: 0,
  previewMatches: false,
  passed: false,
}
app
  .whenReady()
  .then(async () => {
    await mkdir(root, { recursive: true })
    let posted: unknown
    const server = createServer(async (request, response) => {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      posted = JSON.parse(Buffer.concat(chunks).toString())
      result.loopbackPosts++
      response.writeHead(201, { "content-type": "application/json" })
      response.end(JSON.stringify({ submitted: true, receipt: "00000000-0000-4000-8000-000000000585" }))
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Missing fixture server")
    ipcMain.handle("fixture:feedback", (event, value) => {
      if (!isTrustedIpcSender(event)) {
        result.rejectedOrigins++
        throw new Error("Untrusted renderer")
      }
      result.trustedCalls++
      return submitFeedback(value, (_url, init) => net.fetch(`http://127.0.0.1:${address.port}`, init))
    })
    const renderer = await readFile(join(root, "renderer.js"), "utf8")
    protocol.handle(
      "oc",
      (request) =>
        new Response(
          request.url.endsWith("renderer.js")
            ? renderer
            : '<!doctype html><script type="module" src="oc://renderer/renderer.js"></script>',
          { headers: { "content-type": request.url.endsWith("renderer.js") ? "text/javascript" : "text/html" } },
        ),
    )
    try {
      const options = {
        show: false,
        webPreferences: {
          preload: join(root, "preload.cjs"),
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
        },
      }
      const trusted = new BrowserWindow(options)
      windows.push(trusted)
      trusted.webContents.on("console-message", (event) => console.log("fixture renderer:", event.message))
      await trusted.loadURL("oc://renderer/fixture.html")
      const value = await trusted.webContents.executeJavaScript("window.exerciseBridge(window.fixtureApi.submit)")
      result.previewMatches = JSON.stringify(posted) === JSON.stringify(value.preview)
      const untrusted = new BrowserWindow(options)
      windows.push(untrusted)
      await untrusted.loadURL("data:text/html,<html>Untrusted fixture</html>")
      const rejected = await untrusted.webContents.executeJavaScript(
        `window.fixtureApi.submit(${JSON.stringify(value.preview)}).then(() => false, () => true)`,
      )
      result.passed =
        value.proxyRejected &&
        value.invalidRejected &&
        rejected &&
        result.previewMatches &&
        result.loopbackPosts === 1 &&
        result.rejectedOrigins === 1 &&
        value.receipt.receipt === "00000000-0000-4000-8000-000000000585"
      await writeFile(
        join(root, "result.json"),
        JSON.stringify({ ...result, checks: value, untrustedRejected: rejected }, null, 2),
      )
      if (!result.passed) throw new Error("Real bridge fixture failed")
    } finally {
      windows.forEach((window) => window.destroy())
      ipcMain.removeHandler("fixture:feedback")
      protocol.unhandle("oc")
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    console.log(JSON.stringify(result))
    app.quit()
  })
  .catch((error) => {
    console.error(error)
    windows.forEach((window) => window.destroy())
    app.exit(1)
  })
