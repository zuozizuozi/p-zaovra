import assert from "node:assert/strict"
import { createServer } from "node:http"
import { once } from "node:events"
import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile, stat } from "node:fs/promises"
import { resolve, join, relative, isAbsolute } from "node:path"
import { pathToFileURL, fileURLToPath } from "node:url"
import { createRequire } from "node:module"

const options = Object.fromEntries(process.argv.slice(2).map((value) => value.split(/=(.*)/s).slice(0, 2)))
const record = resolve(options.record)
const ownership = resolve(options.ownership)
assert(record && options.executable && options.ownership, "record, executable and new ownership folder required")
assert(
  !relative(resolve(options.isolation), record).startsWith("..") &&
    !isAbsolute(relative(resolve(options.isolation), record)),
)
await mkdir(record)
const requireApp = createRequire(new URL("../../app-ui/package.json", import.meta.url))
const requireDesktop = createRequire(new URL("../../desktop-app/package.json", import.meta.url))
const { build } = await import(pathToFileURL(requireApp.resolve("vite")).href)
const { default: solid } = await import(pathToFileURL(requireApp.resolve("vite-plugin-solid")).href)
const { _electron } = requireDesktop("playwright-core")
const fixture = new URL("./tool-error-card.tsx", import.meta.url)
const compiled = join(record, "compiled")
const component = new URL("../src/components/tool-error-card.tsx", import.meta.url)
const stylesheet = new URL("../src/components/tool-error-card.css", import.meta.url)
const report = {
  scope: "actual ToolErrorCard; production Vite component build; not full desktop/backend or installed Beta",
  started: new Date().toISOString(),
  executable: resolve(options.executable),
  source: options.source,
  componentSHA256: createHash("sha256")
    .update(await readFile(component))
    .digest("hex"),
  stylesheetSHA256: createHash("sha256")
    .update(await readFile(stylesheet))
    .digest("hex"),
  layout: [],
  failures: [],
  pageErrors: [],
  externalRequests: [],
  screenshots: [],
  closed: false,
  modelCalls: 0,
}
await build({
  configFile: false,
  root: fileURLToPath(new URL("..", import.meta.url)),
  plugins: [solid()],
  resolve: {
    dedupe: ["solid-js"],
    conditions: ["browser"],
  },
  build: {
    outDir: compiled,
    emptyOutDir: false,
    sourcemap: true,
    lib: { entry: fileURLToPath(fixture), formats: ["es"], fileName: "fixture", cssFileName: "fixture" },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
})
const server = createServer(async (request, response) => {
  const name = request.url === "/fixture.js" ? "fixture.js" : request.url === "/fixture.css" ? "fixture.css" : null
  response.setHeader(
    "content-type",
    name?.endsWith(".js") ? "text/javascript" : name ? "text/css" : "text/html; charset=utf-8",
  )
  response.end(
    name
      ? await readFile(join(compiled, name))
      : '<!doctype html><html><head><meta charset="UTF-8"><link rel="stylesheet" href="/fixture.css"></head><body style="margin:0"><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>',
  )
})
server.listen(0, "127.0.0.1")
await once(server, "listening")
const url = "http://127.0.0.1:" + server.address().port
const main = join(record, "main.cjs")
await writeFile(
  main,
  'const { app, BrowserWindow } = require("electron"); app.whenReady().then(() => { const window = new BrowserWindow({ width: 820, height: 720, show: true, webPreferences: { contextIsolation: true, nodeIntegration: false } }); window.loadURL(' +
    JSON.stringify(url) +
    '); }); app.on("window-all-closed", () => app.quit());',
)
let app
let requestIndex = 0
const hold = async () => {
  const products = await app.evaluate(({ app }) =>
    app.getAppMetrics().map((item) => ({ pid: item.pid, type: item.type })),
  )
  const name = "request-" + ++requestIndex
  await writeFile(join(ownership, name + ".json"), JSON.stringify(products))
  await new Promise((accept, reject) => {
    const deadline = Date.now() + 15000
    const check = async () => {
      const exists = await stat(join(ownership, name + "-ack.json")).then(
        () => true,
        () => false,
      )
      if (exists) return accept()
      if (Date.now() > deadline) return reject(new Error("new product ownership not acknowledged"))
      setTimeout(check, 50)
    }
    void check()
  })
}
const capture = async (name) => {
  const base64 = await app.evaluate(async ({ BrowserWindow }) =>
    (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString("base64"),
  )
  const bytes = Buffer.from(base64, "base64")
  assert(bytes.length > 0)
  await writeFile(join(record, name), bytes)
  report.screenshots.push({ name, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") })
}
try {
  app = await _electron.launch({
    executablePath: options.executable,
    args: [main, "--user-data-dir=" + join(record, "profile")],
    env: process.env,
  })
  const exited = once(app.process(), "exit")
  const page = await app.firstWindow()
  page.on("pageerror", (error) => report.pageErrors.push(error.stack || error.message))
  page.on("request", (request) => {
    if (!request.url().startsWith(url + "/") && !request.url().startsWith("data:"))
      report.externalRequests.push(request.url())
  })
  await page.locator('[data-case="short"] [data-slot="collapsible-trigger"]').waitFor()
  await hold()
  report.runtime = await app.evaluate(({ app }) => ({
    version: app.getVersion(),
    packaged: app.isPackaged,
    electron: process.versions.electron,
    node: process.versions.node,
  }))
  for (const layout of ["legacy", "v2"]) {
    await page.evaluate((layout) => {
      if (layout === "v2") document.body.setAttribute("data-new-layout", "")
      else document.body.removeAttribute("data-new-layout")
    }, layout)
    for (const width of [820, 360]) {
      await app.evaluate(
        ({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 720),
        width,
      )
      await page.evaluate(() => new Promise((accept) => requestAnimationFrame(() => requestAnimationFrame(accept))))
      const measurements = await page.locator("[data-case]").evaluateAll((cases) =>
        cases.map((element) => {
          const trigger = element.querySelector('[data-slot="collapsible-trigger"]')
          const card = element.querySelector('[data-kind="tool-error-card"]')
          const rect = trigger.getBoundingClientRect()
          const bounds = card.getBoundingClientRect()
          const violations = []
          const text = Array.from(
            element.querySelectorAll('[data-slot="basic-tool-tool-title"], [data-slot="basic-tool-tool-subtitle"]'),
          ).map((node) => {
            const range = document.createRange()
            range.selectNodeContents(node)
            const lines = Array.from(range.getClientRects()).map((line) => ({
              top: line.top,
              bottom: line.bottom,
              left: line.left,
              right: line.right,
            }))
            for (const line of lines)
              if (
                line.top < rect.top - 1 ||
                line.bottom > rect.bottom + 1 ||
                line.left < rect.left - 1 ||
                line.right > rect.right + 1
              )
                violations.push(node.getAttribute("data-slot") + " text outside trigger")
            return { value: node.textContent, lines, clientWidth: node.clientWidth, scrollWidth: node.scrollWidth }
          })
          if (bounds.bottom < rect.bottom - 1) violations.push("trigger outside card")
          return {
            id: element.getAttribute("data-case"),
            trigger: { top: rect.top, bottom: rect.bottom, height: rect.height, width: rect.width },
            text,
            violations,
          }
        }),
      )
      report.layout.push({ layout, width, measurements })
      for (const item of measurements) {
        if (item.violations.length) report.failures.push({ layout, width, id: item.id, violations: item.violations })
        if (item.id === "short" && Math.abs(item.trigger.height - 32) > 1)
          report.failures.push({ layout, width, id: item.id, shortHeight: item.trigger.height })
      }
      if (layout === "legacy") await capture("closed-" + width + ".png")
    }
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(820, 720))
  const card = page.locator('[data-case="long-en"]')
  const trigger = card.locator('[data-slot="collapsible-trigger"]')
  await trigger.click()
  await card.locator('[data-slot="card-description"]').waitFor({ state: "visible" })
  assert.equal(await trigger.getAttribute("aria-expanded"), "true")
  assert.equal(
    await card.locator('[data-slot="card-description"]').textContent(),
    await card.getAttribute("data-error"),
  )
  await capture("expanded.png")
  await card.hover()
  await card.locator('[data-slot="tool-error-card-copy"] button').click()
  report.copied = await app.evaluate(({ clipboard }) => clipboard.readText())
  assert.equal(report.copied, await card.getAttribute("data-error"))
  await trigger.focus()
  await page.keyboard.press("Space")
  assert.equal(await trigger.getAttribute("aria-expanded"), "false")
  await page.locator('[data-case="link"] a').click()
  assert.equal(
    await page.locator('[data-case="link"] [data-slot="collapsible-trigger"]').getAttribute("aria-expanded"),
    "false",
  )
  assert(page.url().endsWith("#task-details"))
  await hold()
  report.interactions = {
    pointerExpand: true,
    fullDetails: true,
    clipboardExact: true,
    keyboardCollapse: true,
    linkDoesNotToggle: true,
  }
  assert.equal(report.pageErrors.length, 0)
  assert.equal(report.externalRequests.length, 0)
  await app.close()
  app = undefined
  report.appExit = await exited
  report.closed = true
  assert.equal(report.appExit[0], 0)
  assert.equal(report.failures.length, 0, "all closed summary text must fit actual trigger bounds")
} catch (error) {
  report.error = error.stack || String(error)
  process.exitCode = 1
} finally {
  if (app) {
    const exited = once(app.process(), "exit")
    await app.close()
    report.appExit = await exited
    report.closed = true
  }
  await writeFile(join(ownership, "finish.json"), JSON.stringify({ at: new Date().toISOString() }))
  await new Promise((accept) => server.close(accept))
  report.ended = new Date().toISOString()
  await writeFile(join(record, "result.json"), JSON.stringify(report, null, 2))
  console.log(
    JSON.stringify({
      record,
      failures: report.failures.length,
      pageErrors: report.pageErrors.length,
      interactions: report.interactions,
      closed: report.closed,
      error: report.error,
    }),
  )
}
