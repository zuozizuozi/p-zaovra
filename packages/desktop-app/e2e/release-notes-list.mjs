import assert from "node:assert/strict"
import { createServer } from "node:http"
import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve, relative, isAbsolute, extname } from "node:path"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"
import { mockZaovraServer } from "../../app-ui/e2e/utils/mock-server.ts"
const { _electron } = createRequire(import.meta.url)("playwright-core")
const [executable, root, name, locale = "zh", theme = "light"] = process.argv.slice(2)
const tailOnly = process.argv[8] === "tail"
const record = join(resolve(root), name)
const profile = join(record, "profile")
const directory = join(record, "project").replaceAll("\\", "/")
const renderer = join(resolve(root), process.argv[7] ?? "desktop-renderer-dialog750")
const copy = JSON.parse(await readFile(new URL("../../app-ui/src/release-notes/current.json", import.meta.url), "utf8"))
assert.match(copy.version, /^\d+\.\d+\.\d+-beta\.[1-9]\d*$/, "exact generated Beta version required")
const report = {
  locale,
  theme,
  actualUiVersion: copy.version,
  scope: "750 native production release dialog",
  apps: [],
  requests: [],
  pageErrors: [],
  failedResponses: [],
  screenshots: [],
  modelCalls: 0,
}
await mkdir(directory, { recursive: true })
const streams = new Set()
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, "http://local").pathname
  report.requests.push({ method: request.method, path: pathname })
  if (pathname === "/global/event" || pathname === "/event") {
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
    response.write(
      "data: " + JSON.stringify({ directory, payload: { type: "server.connected", properties: {} } }) + "\n\n",
    )
    streams.add(response)
    request.on("close", () => streams.delete(response))
    return
  }
  const path = resolve(renderer, pathname.slice(1) || "index.html")
  const inside = relative(renderer, path)
  if (inside.startsWith("..") || isAbsolute(inside)) {
    response.writeHead(403).end()
    return
  }
  const bytes = await readFile(path).catch(() => null)
  if (!bytes) {
    response.writeHead(404).end()
    return
  }
  const mime = {
    ".html": "text/html",
    ".js": "application/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ttf": "font/ttf",
    ".woff2": "font/woff2",
  }
  response
    .writeHead(200, { "content-type": mime[extname(path)] ?? "application/octet-stream", "cache-control": "no-store" })
    .end(bytes)
})
await new Promise((done) => server.listen(0, "127.0.0.1", done))
const origin = "http://127.0.0.1:" + server.address().port
const optionsPath = join(record, "host-options.json")
await writeFile(
  optionsPath,
  JSON.stringify(
    {
      root: resolve(root),
      profile,
      directory,
      origin,
      locale,
      previousVersion: "0.1.1-beta.16",
      preload: join(resolve(root), "desktop-host/index.js"),
      storageBundle: join(resolve(root), "desktop-host/store-entry751.js"),
      journal: join(record, "ipc-journal.jsonl"),
    },
    null,
    2,
  ),
)
const fixture = {
  origin,
  directory,
  project: {
    id: "proj_notes750",
    worktree: directory,
    vcs: "git",
    name: "Release dialog750",
    time: { created: 1700000000000, updated: 1700000000000 },
    sandboxes: [],
  },
  provider: { all: [], connected: [], default: {} },
  sessions: [],
  pageMessages: () => ({ items: [] }),
  sessionStatus: {},
  activeSessions: {},
}
let app
async function ownership() {
  const values = await app.evaluate(({ app }) =>
    app.getAppMetrics().map((item) => ({ pid: item.pid, type: item.type })),
  )
  const pid = app.process().pid
  if (!values.some((item) => item.pid === pid)) values.unshift({ pid, type: "Browser" })
  const path = join(record, "processes-1-" + Date.now() + ".json")
  await writeFile(path, JSON.stringify(values, null, 2))
  const end = Date.now() + 10000
  while (!(await readFile(path.replace(".json", "-ack.json")).catch(() => null))) {
    assert(Date.now() < end, "new live ownership recorder acknowledgement")
    await new Promise((done) => setTimeout(done, 25))
  }
}
async function capture(label, rect) {
  const data = await app.evaluate(async ({ BrowserWindow }, rect) => {
    const image = await BrowserWindow.getAllWindows()[0].capturePage(rect)
    return (rect ? image.resize({ width: image.getSize().width * 2, quality: "best" }) : image)
      .toPNG()
      .toString("base64")
  }, rect)
  const bytes = Buffer.from(data, "base64")
  assert(bytes.length > 1000)
  const path = join(record, label + ".png")
  await writeFile(path, bytes)
  report.screenshots.push({
    path,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    method: rect ? "native capture dialog region, 200percent" : "native BrowserWindow.capturePage",
  })
}
async function close() {
  if (!app) return
  await ownership()
  const exit = new Promise((done) => app.process().once("exit", (code, signal) => done({ code, signal })))
  await app.close()
  report.apps.at(-1).exit = await exit
  assert.deepEqual(report.apps.at(-1).exit, { code: 0, signal: null })
  app = undefined
}
try {
  app = await _electron.launch({
    executablePath: resolve(executable),
    args: [
      fileURLToPath(new URL("./release-notes-host.mjs", import.meta.url)),
      optionsPath,
      "--user-data-dir=" + profile,
      "--lang=" + (locale === "zh" ? "zh-CN" : "en-US"),
    ],
    timeout: 30000,
    env: Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !/TOKEN|SECRET|PASSWORD|API_KEY|SENTRY|CLOUDFLARE|^R2_|^AWS_|^AZURE_|^WINDOWS_SIGNING_/.test(key),
      ),
    ),
  })
  report.apps.push(
    await app.evaluate(({ app }) => ({
      version: app.getVersion(),
      packaged: app.isPackaged,
      electron: process.versions.electron,
      node: process.versions.node,
      profile: app.getPath("userData"),
    })),
  )
  const page = await app.firstWindow()
  page.setDefaultTimeout(15000)
  page.on("pageerror", (error) => report.pageErrors.push(String(error)))
  page.on("response", (response) => {
    if (response.status() >= 400) report.failedResponses.push({ status: response.status(), url: response.url() })
  })
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/(chat\/completions|responses)$/.test(new URL(request.url()).pathname))
      report.modelCalls++
  })
  await ownership()
  await mockZaovraServer(page, fixture)
  for (const pattern of ["**/global/event", "**/event"]) await page.route(pattern, (route) => route.continue())
  await page.addInitScript((theme) => localStorage.setItem("zaovra-color-scheme", theme), theme)
  await app.evaluate(({ BrowserWindow }, url) => BrowserWindow.getAllWindows()[0].loadURL(url), origin + "/index.html")
  const dialog = page.getByRole("dialog").filter({ has: page.locator("[data-release-notes]") })
  await dialog.waitFor({ state: "visible" })
  await page.waitForFunction((theme) => document.documentElement.dataset.colorScheme === theme, theme)
  if (!tailOnly) {
    const expectedTitle = locale === "zh" ? copy.version + " 更新内容" : "What’s new in " + copy.version
    await dialog.getByText(expectedTitle, { exact: true }).waitFor()
    assert.equal(await dialog.locator("li").count(), copy[locale].length)
    for (const item of copy[locale]) {
      await dialog.getByText(item.title, { exact: true }).waitFor()
      await dialog.getByText(item.description, { exact: true }).waitFor()
    }
    assert.equal(await dialog.getByRole("button", { name: /^(下一步|Next)$/ }).count(), 0)
    assert.equal(
      await dialog
        .locator("span.text-12-medium.text-text-weak")
        .filter({ hasText: /^(请重点测|Please focus testing)$/ })
        .count(),
      0,
    )
    report.geometry = await dialog.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      const list = element.querySelector("[data-release-notes-list]")
      const buttons = [...element.querySelector("[data-release-notes-actions]").querySelectorAll("button")].map(
        (node) => ({
          text: node.textContent,
          x: node.getBoundingClientRect().x,
          right: node.getBoundingClientRect().right,
          top: node.getBoundingClientRect().top,
        }),
      )
      return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        listHeight: list.clientHeight,
        listScrollHeight: list.scrollHeight,
        buttons,
        background: getComputedStyle(element).backgroundColor,
      }
    })
    assert(Math.abs(report.geometry.width - 520) <= 1)
    assert(report.geometry.height < 600)
    assert(report.geometry.buttons[0].right < report.geometry.buttons[1].x)
    assert.equal(
      report.geometry.listHeight,
      report.geometry.listScrollHeight,
      "all approved entries visible on one screen",
    )
    await capture("01-" + locale + "-" + theme)
    await capture("02-dialog-200percent", {
      x: Math.floor(report.geometry.x),
      y: Math.floor(report.geometry.y),
      width: Math.ceil(report.geometry.width),
      height: Math.ceil(report.geometry.height),
    })
  }
  report.initialAssertionsSkipped = tailOnly
  report.focusBeforeEnter = await page.evaluate(() => ({
    tag: document.activeElement?.tagName,
    inDialog: !!document.activeElement?.closest("[data-release-notes]"),
    text: document.activeElement?.textContent?.slice(0, 80),
  }))
  await page.keyboard.press("Enter")
  await dialog.waitFor({ state: "hidden" })
  report.enterClosed = true
  async function openAboutNotes() {
    await page
      .locator('[data-component="desktop-rail"]')
      .getByRole("button", { name: locale === "zh" ? "设置" : "Settings", exact: true })
      .click()
    await page.getByRole("menuitem", { name: locale === "zh" ? "关于 Zaovra" : "About Zaovra", exact: true }).click()
    await page
      .getByRole("button", {
        name: locale === "zh" ? "查看本版更新内容" : "View this version’s release notes",
        exact: true,
      })
      .click()
    await dialog.waitFor({ state: "visible" })
    assert.equal(await dialog.locator("li").count(), copy[locale].length)
  }
  await openAboutNotes()
  report.aboutSameList = true
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 420))
  await page.waitForTimeout(120)
  report.shortWindow = await dialog.evaluate((element) => {
    const list = element.querySelector("[data-release-notes-list]")
    const footer = element.querySelector("[data-release-notes-actions]").getBoundingClientRect()
    return {
      listHeight: list.clientHeight,
      listScrollHeight: list.scrollHeight,
      footerBottom: footer.bottom,
      viewport: innerHeight,
      dialogScrollHeight: element.scrollHeight,
      dialogHeight: element.clientHeight,
    }
  })
  assert(report.shortWindow.listScrollHeight > report.shortWindow.listHeight)
  assert(report.shortWindow.footerBottom <= report.shortWindow.viewport)
  await dialog.locator("[data-release-notes-list]").hover()
  await page.mouse.wheel(0, 200)
  await page.waitForFunction(() => (document.querySelector("[data-release-notes-list]")?.scrollTop ?? 0) > 0)
  assert(await dialog.locator("[data-release-notes-list]").evaluate((element) => element.scrollTop > 0))
  await page.keyboard.press("Escape")
  await dialog.waitFor({ state: "hidden" })
  report.escapeClosed = true
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1400, 900))
  await openAboutNotes()
  await dialog.getByRole("button", { name: locale === "zh" ? "不再显示" : "Don't show again", exact: true }).click()
  await dialog.waitFor({ state: "hidden" })
  report.disabled = await page.evaluate(
    async () => JSON.parse(await window.api.storeGet("default.dat", "settings.v3"))?.general?.releaseNotes === false,
  )
  assert.equal(report.disabled, true)
  assert.deepEqual(report.pageErrors, [])
  assert.deepEqual(report.failedResponses, [])
  assert.equal(report.modelCalls, 0)
  await close()
  report.passed = true
} catch (error) {
  report.error = { message: String(error), stack: error.stack }
  process.exitCode = 1
  if (app) {
    const page = await app.firstWindow().catch(() => null)
    if (page) await writeFile(join(record, "failure-dom.html"), await page.content())
    await capture("failure").catch(() => {})
  }
} finally {
  await close().catch((error) => {
    report.closeError = String(error)
    process.exitCode = 1
  })
  for (const response of streams) response.end()
  await new Promise((done) => server.close(done))
  await writeFile(join(record, "result.json"), JSON.stringify(report, null, 2))
  await writeFile(join(record, "finish.json"), JSON.stringify({ closed: !app }))
  console.log(
    JSON.stringify({
      passed: report.passed,
      error: report.error,
      geometry: report.geometry,
      shortWindow: report.shortWindow,
      apps: report.apps,
    }),
  )
}
