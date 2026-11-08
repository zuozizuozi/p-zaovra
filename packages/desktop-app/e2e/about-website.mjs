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
const record = join(resolve(root), name)
const profile = join(record, "profile")
const directory = join(record, "project").replaceAll("\\", "/")
const renderer = join(resolve(root), process.argv[7] ?? "desktop-renderer-about751")
const report = {
  locale,
  theme,
  actualUiVersion: "source Dev 0.1.0",
  scope: "751 native production About website",
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
      previousVersion: "0.1.0",
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
  const websiteLabel = locale === "zh" ? "访问官网" : "Visit website"
  await page
    .locator('[data-component="desktop-rail"]')
    .getByRole("button", { name: locale === "zh" ? "设置" : "Settings", exact: true })
    .click()
  await page.getByRole("menuitem", { name: locale === "zh" ? "关于 Zaovra" : "About Zaovra", exact: true }).click()
  const website = page.getByRole("link", { name: websiteLabel, exact: true })
  await website.waitFor({ state: "visible" })
  await page.waitForFunction((theme) => document.documentElement.dataset.colorScheme === theme, theme)
  assert.equal(await website.count(), 1)
  assert.equal(await page.getByText(locale === "zh" ? "第三方声明" : "Third-party notices", { exact: true }).count(), 0)
  await page.getByText("© 2026 Zaovra", { exact: true }).waitFor({ state: "visible" })
  assert.equal(await website.getAttribute("href"), "https://zaovra.com")
  await website.click()
  const end = Date.now() + 5000
  while (
    !(await readFile(join(record, "ipc-journal.jsonl"), "utf8")).includes(
      '"operation":"blocked-open-link","url":"https://zaovra.com"',
    )
  ) {
    assert(Date.now() < end, "website uses actual external-link IPC")
    await new Promise((done) => setTimeout(done, 25))
  }
  const journal = (await readFile(join(record, "ipc-journal.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
  report.websiteOpens = journal.filter((entry) => entry.operation === "blocked-open-link")
  assert.deepEqual(
    report.websiteOpens.map((entry) => entry.url),
    ["https://zaovra.com"],
  )
  report.blockedExternalRequests = journal.filter((entry) => entry.operation === "blocked-external-request")
  assert.deepEqual(report.blockedExternalRequests, [])
  report.geometry = await website.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, visible: rect.width > 0 && rect.height > 0 }
  })
  await capture("01-about-" + locale + "-" + theme)
  const panel = page.locator(".settings-v2-tab-body").filter({ has: page.getByText("© 2026 Zaovra", { exact: true }) })
  const rect = await panel.boundingBox()
  assert(rect && rect.width > 0)
  await capture("02-about-detail-200percent", {
    x: Math.floor(rect.x),
    y: Math.floor(rect.y),
    width: Math.ceil(rect.width),
    height: Math.ceil(rect.height),
  })
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
