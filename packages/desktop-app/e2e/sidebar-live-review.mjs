import assert from "node:assert/strict"
import { createServer } from "node:http"
import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile, stat } from "node:fs/promises"
import { join, resolve, relative, isAbsolute, extname } from "node:path"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"
import { mockZaovraServer } from "../../app-ui/e2e/utils/mock-server.ts"
const { _electron } = createRequire(import.meta.url)("playwright-core")
const [executable, root, recordName = "ui-live751"] = process.argv.slice(2)
const record = join(resolve(root), recordName)
const mode = process.argv[5] ?? "live"
const previous = undefined
const profile = previous?.profile ?? join(record, "profile")
const directory = previous?.directory ?? join(record, "project").replaceAll("\\", "/")
const report = {
  source: "a8ab2a08",
  scope: "751 actual live completion and active navigation; busy circle without status text",
  assertions: [],
  screenshots: [],
  pageErrors: [],
  failedResponses: [],
  apps: [],
  requests: [],
  modelCalls: 0,
  externalRequests: [],
}
await mkdir(directory, { recursive: true })
const sessions = [
  {
    id: "ses_unread751_background",
    title: "Background recovery 751",
    slug: "background",
    projectID: "proj_unread751",
    directory,
    version: "dev",
    time: { created: 1700000000000, updated: 1700000001000 },
  },
  {
    id: "ses_unread751_foreground",
    title: "Foreground owner 751",
    slug: "foreground",
    projectID: "proj_unread751",
    directory,
    version: "dev",
    time: { created: 1700000002000, updated: 1700000003000 },
  },
]
const background = sessions[0].id
const foreground = sessions[1].id
const state = { completed: !!previous }
const completionWaiters = new Set()
const streams = new Set()
const mime = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".wasm": "application/wasm",
}
const renderer = join(resolve(root), process.argv[6] ?? "desktop-renderer-baseline-v2751")
const server = createServer(async (request, response) => {
  report.requests.push({ method: request.method, path: new URL(request.url, "http://local").pathname })
  if (/^\/(global\/)?event(?:\?|$)/.test(request.url)) {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "access-control-allow-origin": "*",
    })
    response.write(": connected\n\n")
    streams.add(response)
    request.on("close", () => streams.delete(response))
    return
  }
  const name = decodeURIComponent(new URL(request.url, "http://local").pathname).slice(1) || "index.html"
  const path = resolve(renderer, name)
  const inside = relative(renderer, path)
  if (inside.startsWith("..") || isAbsolute(inside)) return response.writeHead(403).end()
  const bytes = await readFile(path).catch(() => null)
  if (!bytes) return response.writeHead(404).end()
  response.writeHead(200, {
    "content-type": mime[extname(path)] ?? "application/octet-stream",
    "cache-control": "no-store",
  })
  response.end(bytes)
})
await new Promise((resolve) =>
  server.listen(previous ? Number(new URL(previous.origin).port) : 0, "127.0.0.1", resolve),
)
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
    id: "proj_unread751",
    worktree: directory,
    vcs: "git",
    name: "Recovery verification",
    time: { created: 1700000000000, updated: 1700000001000 },
    sandboxes: [],
  },
  provider: {
    all: [
      {
        id: "fixture",
        name: "Local fixture",
        models: { fixed: { id: "fixed", name: "Fixed fixture", limit: { context: 100000, output: 1000 } } },
      },
    ],
    connected: ["fixture"],
    default: { providerID: "fixture", modelID: "fixed" },
  },
  sessions,
  pageMessages: (id) => ({ items: messages(id) }),
  get sessionStatus() {
    return { [background]: state.completed ? { type: "idle" } : { type: "busy" }, [foreground]: { type: "idle" } }
  },
  get activeSessions() {
    return state.completed ? {} : { [background]: { type: "running" } }
  },
}
function messages(id) {
  const user = {
    info: {
      id: "msg_1000_" + id + "_user",
      sessionID: id,
      role: "user",
      time: { created: 1700000000000 },
      agent: "build",
      model: { providerID: "fixture", modelID: "fixed" },
    },
    parts: [
      {
        id: "prt_" + id + "_user",
        sessionID: id,
        messageID: "msg_1000_" + id + "_user",
        type: "text",
        text: "Verify recovery without model traffic.",
      },
    ],
  }
  const done = id !== background || state.completed
  const assistant = {
    info: {
      id: "msg_1001_" + id + "_assistant",
      sessionID: id,
      role: "assistant",
      time: { created: 1700000001000, ...(done ? { completed: 1700000002000 } : {}) },
      parentID: user.info.id,
      providerID: "fixture",
      modelID: "fixed",
      mode: "build",
      agent: "build",
      path: { cwd: directory, root: directory },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [
      {
        id: "prt_" + id + "_answer",
        sessionID: id,
        messageID: "msg_1001_" + id + "_assistant",
        type: "text",
        text: done ? "Completed response for " + id : "Background work in progress",
      },
    ],
  }
  return [user, assistant]
}
async function until(read, check, label, timeout = 15000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const value = await read()
    if (check(value)) return value
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw Error("Timed out: " + label)
}
async function notificationDisk() {
  const path = join(profile, "zaovra.global.dat")
  const bytes = await readFile(path).catch(() => null)
  if (!bytes) return null
  const store = JSON.parse(bytes)
  for (const [key, raw] of Object.entries(store)) {
    if (typeof raw !== "string" || !raw.includes("pendingCompletions")) continue
    const value = JSON.parse(raw)
    if (value && typeof value === "object" && "pendingCompletions" in value)
      return { path, sha256: createHash("sha256").update(bytes).digest("hex"), key, value }
  }
  return null
}
let current
let launch = 0
async function ownership(app) {
  const values = await app.evaluate(({ app }) =>
    app.getAppMetrics().map((item) => ({ pid: item.pid, type: item.type })),
  )
  const pid = app.process().pid
  if (!values.some((item) => item.pid === pid)) values.unshift({ pid, type: "Browser" })
  const path = join(record, "processes-" + launch + "-" + Date.now() + ".json")
  await writeFile(path, JSON.stringify(values, null, 2))
  await until(
    () =>
      readFile(path.replace(".json", "-ack.json"))
        .then((bytes) => JSON.parse(bytes))
        .catch(() => null),
    (value) => Array.isArray(value) && value.length === values.length,
    "owned live handles",
  )
}
async function start() {
  launch++
  const app = await _electron.launch({
    executablePath: resolve(executable),
    timeout: 30000,
    args: [
      fileURLToPath(new URL("./sidebar-unread-host.mjs", import.meta.url)),
      optionsPath,
      "--user-data-dir=" + profile,
      "--lang=en-US",
    ],
    env: Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !/TOKEN|SECRET|PASSWORD|API_KEY|SENTRY|CLOUDFLARE|^R2_|^AWS_|^AZURE_|^WINDOWS_SIGNING_/.test(key),
      ),
    ),
  })
  current = app
  const page = await app.firstWindow()
  page.setDefaultTimeout(15000)
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/")) {
      report.apiRequests ??= []
      report.apiRequests.push({ launch, method: request.method(), path: new URL(request.url()).pathname })
    }
  })
  page.on("response", async (response) => {
    const path = new URL(response.url()).pathname
    if (path === "/api/session/active" || path.includes(background)) {
      report.snapshotResponses ??= []
      report.snapshotResponses.push({
        launch,
        path,
        status: response.status(),
        body: await response.json().catch(() => null),
      })
    }
  })
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/(chat\/completions|responses)$/.test(new URL(request.url()).pathname))
      report.modelCalls++
  })
  page.on("pageerror", (error) => report.pageErrors.push({ launch, error: String(error), stack: error.stack }))
  page.on("console", (message) => {
    if (message.type() === "error") report.failedResponses.push({ launch, console: message.text() })
  })
  page.on("response", (response) => {
    if (response.status() >= 400)
      report.failedResponses.push({ launch, status: response.status(), url: response.url() })
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
  await ownership(app)
  await mockZaovraServer(page, fixture)
  await page.route("**/api/session/*/wait", async (route) => {
    if (new URL(route.request().url()).pathname.includes(background) && !state.completed)
      await new Promise((resolve) => completionWaiters.add(resolve))
    await route
      .fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: {} }) })
      .catch(() => {})
  })
  for (const pattern of ["**/global/event", "**/event"]) await page.route(pattern, (route) => route.continue())
  await app.evaluate(({ BrowserWindow }, url) => BrowserWindow.getAllWindows()[0].loadURL(url), origin + "/index.html")
  await page.locator('[data-component="desktop-sidebar-v2"]').waitFor({ state: "visible" })
  await until(
    () => Promise.resolve(streams.size),
    (value) => value > 0,
    "actual SSE connection",
  )

  return { app, page }
}
function row(page, id) {
  return page
    .locator('[data-component="desktop-sidebar-v2"] [data-slot="titlebar-tab-item"]')
    .filter({ has: page.locator('a[href$="/session/' + id + '"]') })
}
async function capture(app, name) {
  const data = await app.evaluate(async ({ BrowserWindow }) =>
    (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString("base64"),
  )
  const path = join(record, name + ".png")
  const bytes = Buffer.from(data, "base64")
  assert(bytes.length > 1000, "native capture nonempty")
  await writeFile(path, bytes)
  report.screenshots.push({
    path,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    method: "Electron BrowserWindow.capturePage",
  })
}
async function close(app) {
  await ownership(app)
  const child = app.process()
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })))
  await app.close()
  report.apps.at(-1).exit = await exited
  assert.equal(report.apps.at(-1).exit.code, 0)
  current = undefined
}
try {
  const live = await start()
  await row(live.page, background).locator("a").click()
  await row(live.page, background).locator('[data-slot="session-running-ring"]').waitFor()
  const ring = row(live.page, background).locator('[data-slot="session-running-ring"]')
  const transforms = []
  for (let frame = 0; frame < 3; frame++) {
    transforms.push(
      await ring.evaluate((node) => ({
        transform: getComputedStyle(node).transform,
        animation: getComputedStyle(node).animationName,
        duration: getComputedStyle(node).animationDuration,
        playState: getComputedStyle(node).animationPlayState,
        animations: node.getAnimations().map((item) => ({ time: item.currentTime, state: item.playState })),
        reduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
      })),
    )
    if (mode === "running" && frame < 2) await capture(live.app, "running-frame-" + frame)
    await live.page.waitForTimeout(120)
  }
  report.busy = {
    labelCount: await row(live.page, background).locator('[data-slot="sidebar-session-status"]').count(),
    transforms,
  }
  assert(new Set(transforms.map((item) => item.transform)).size > 1, "busy ring rotates in native renderer")
  report.assertions.push("actual busy circle visibly rotates")
  await capture(live.app, "01-live-busy")
  if (mode === "live") {
    await row(live.page, foreground).locator("a").click()
    await until(
      () => row(live.page, foreground).getAttribute("data-active"),
      (value) => value === "true",
      "foreground tab settled",
    )
    state.completed = true
    for (const done of completionWaiters) done()
    completionWaiters.clear()
    const answer = messages(background)[1]
    const events = [
      { type: "message.updated", properties: { info: answer.info } },
      { type: "message.part.updated", properties: { part: answer.parts[0] } },
      { type: "session.status", properties: { sessionID: background, status: { type: "idle" } } },
    ]
    for (const payload of events)
      for (const stream of streams) stream.write("data: " + JSON.stringify({ directory, payload }) + "\n\n")
    report.deliveredEvents = events.map((item) => item.type)
    await row(live.page, background).locator('[data-slot="session-unread-dot"]').waitFor()
    assert.equal(await row(live.page, foreground).getAttribute("data-active"), "true")
    await capture(live.app, "02-live-completed-unread")
    await row(live.page, background).locator("a").click()
    await until(
      () => row(live.page, background).getAttribute("data-active"),
      (value) => value === "true",
      "completed tab selected",
    )
    await until(
      () => row(live.page, background).locator('[data-slot="session-unread-dot"]').count(),
      (value) => value === 0,
      "selected completed tab clears blue dot",
    )
    const disk = await until(
      () => notificationDisk(),
      (value) => value?.value.list.some((item) => item.session === background && item.viewed),
      "viewed persists via real IPC",
    )
    await writeFile(join(record, "storage-live-viewed.json"), JSON.stringify(disk, null, 2))
    await row(live.page, background).locator("a").click()
    assert.equal(await row(live.page, background).locator('[data-slot="session-unread-dot"]').count(), 0)
    report.assertions.push(
      "live SSE completion while background shows blue; actual navigation and repeated selected-row click clear blue and persist viewed",
    )
    await capture(live.app, "03-live-viewed-cleared")
  }
  assert.deepEqual(report.pageErrors, [])
  assert.deepEqual(report.failedResponses, [])
  assert.equal(report.busy.labelCount, 0, "busy status uses circle only, no in-progress text")
  await close(live.app)
  report.passed = true
} catch (error) {
  report.error = { message: String(error), stack: error.stack }
  if (current) {
    const page = await current.firstWindow().catch(() => null)
    if (page) await writeFile(join(record, "failure-dom.html"), await page.content()).catch(() => {})
    await capture(current, "failure").catch(() => {})
  }
  process.exitCode = 1
} finally {
  for (const done of completionWaiters) done()
  completionWaiters.clear()
  if (current)
    await close(current).catch((error) => {
      report.closeError = String(error)
      process.exitCode = 1
    })
  for (const response of streams) response.end()
  await new Promise((resolve) => server.close(resolve))
  await writeFile(join(record, "result.json"), JSON.stringify(report, null, 2))
  await writeFile(join(record, "finish.json"), JSON.stringify({ at: new Date().toISOString(), closed: !current }))
  console.log(JSON.stringify(report, null, 2))
}
