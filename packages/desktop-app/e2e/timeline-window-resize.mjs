import assert from "node:assert/strict"
import { requireContinuousResizeFollow } from "./timeline-window-resize-contract.mjs"
import { createServer } from "node:http"
import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile, stat } from "node:fs/promises"
import { join, resolve, relative, isAbsolute, extname } from "node:path"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"
import { mockZaovraServer } from "../../app-ui/e2e/utils/mock-server.ts"
const { _electron } = createRequire(import.meta.url)("playwright-core")
const [executable, root, recordName = "resize-baseline751"] = process.argv.slice(2)
const record = join(resolve(root), recordName)
const mode = process.argv[5] ?? "live"
const previous = undefined
const profile = previous?.profile ?? join(record, "profile")
const directory = previous?.directory ?? join(record, "project").replaceAll("\\", "/")
const report = {
  source: "909d32ac",
  scope: "751 production window resize while V2 text streams; follow and user reading anchors",
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
const baseTime = Date.now()
const state = {
  completed: false,
  text:
    Array.from(
      { length: 70 },
      (_, i) =>
        "RESIZE_PARA_" +
        i +
        ": This is a fixed production timeline paragraph for window resize testing. A readable place must stay stable while the viewport changes size.",
    ).join("\n\n") + "\n\nRESIZE_STREAM_START",
}
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
const renderer = join(resolve(root), process.argv[6] ?? "desktop-renderer-resize-baseline751")
const server = createServer(async (request, response) => {
  report.requests.push({ method: request.method, path: new URL(request.url, "http://local").pathname })
  if (/^\/(global\/)?event(?:\?|$)/.test(request.url)) {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "access-control-allow-origin": "*",
    })
    response.write(
      "data: " + JSON.stringify({ directory, payload: { type: "server.connected", properties: {} } }) + "\n\n",
    )
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
  return [
    {
      id: "msg_1000_" + id + "_user",
      type: "user",
      time: { created: baseTime - 1000 },
      text: "Verify native window resizing during streaming without model traffic.",
      files: [],
      agents: [],
    },
    {
      id: "msg_1001_" + id + "_assistant",
      type: "assistant",
      time: { created: baseTime },
      agent: "build",
      model: { id: "fixed", providerID: "fixture" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      content: [
        { id: "text_resize751", type: "text", text: id === background ? state.text : "Foreground fixture response" },
      ],
    },
  ]
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
const gapTasks = new Set()
let gapCount = 0
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
  await page.exposeFunction("captureResizeGap751", async (observed) => {
    if (gapCount >= 2) return
    const index = gapCount++
    const task = (async () => {
      const read = () =>
        page.evaluate(() => {
          const root = document.querySelector("[data-timeline-key]")?.closest(".scroll-view__viewport")
          return root
            ? {
                ms: performance.now(),
                distance: root.scrollHeight - root.clientHeight - root.scrollTop,
                top: root.scrollTop,
                height: root.scrollHeight,
                viewport: root.clientHeight,
              }
            : null
        })
      const before = await read()
      await capture(app, "gap-native-" + index)
      const after = await read()
      report.gapObservations ??= []
      report.gapObservations.push({ observed, before, after })
    })().catch((error) => {
      report.gapCaptureErrors ??= []
      report.gapCaptureErrors.push(String(error))
    })
    gapTasks.add(task)
    await task
    gapTasks.delete(task)
  })
  await page.addInitScript(() => {
    window.__resize751 = { phase: "startup", samples: [], writes: [], running: true }
    const sample = () => {
      if (!window.__resize751.running) return
      const root = document.querySelector("[data-timeline-key]")?.closest(".scroll-view__viewport")
      if (root && window.__resize751.samples.length < 2000) {
        const rect = root.getBoundingClientRect()
        window.__resize751.samples.push({
          ms: performance.now(),
          phase: window.__resize751.phase,
          top: root.scrollTop,
          height: root.scrollHeight,
          viewport: root.clientHeight,
          width: root.clientWidth,
          distance: root.scrollHeight - root.clientHeight - root.scrollTop,
          rectTop: rect.top,
          windowWidth: innerWidth,
          windowHeight: innerHeight,
        })
        const measured = window.__resize751.samples.at(-1)
        if (measured.phase === "follow-narrow" && measured.distance > 2 && (window.__resize751.gapRequests ?? 0) < 2) {
          window.__resize751.gapRequests = (window.__resize751.gapRequests ?? 0) + 1
          void window.captureResizeGap751(measured)
        }
      }
      requestAnimationFrame(() => setTimeout(sample, 0))
    }
    requestAnimationFrame(sample)
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")
    if (descriptor?.get && descriptor.set)
      Object.defineProperty(Element.prototype, "scrollTop", {
        ...descriptor,
        set(value) {
          if (
            this.classList?.contains("scroll-view__viewport") &&
            this.querySelector("[data-timeline-key]") &&
            window.__resize751.writes.length < 1000
          )
            window.__resize751.writes.push({
              ms: performance.now(),
              phase: window.__resize751.phase,
              kind: "scrollTop",
              from: descriptor.get.call(this),
              to: value,
              stack: new Error().stack,
            })
          descriptor.set.call(this, value)
        },
      })
  })
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
let streamTimer
try {
  const readyStart = Date.now()
  const live = await start()
  await row(live.page, background).locator("a").click()
  await live.page.getByText("RESIZE_STREAM_START", { exact: false }).waitFor()
  report.readyMs = Date.now() - readyStart
  const viewport = live.page
    .locator(".scroll-view__viewport")
    .filter({ has: live.page.locator("[data-timeline-key]") })
    .first()
  const measure = () =>
    viewport.evaluate((root) => ({
      top: root.scrollTop,
      height: root.scrollHeight,
      viewport: root.clientHeight,
      distance: root.scrollHeight - root.clientHeight - root.scrollTop,
      width: root.clientWidth,
    }))
  const phase = (value) => live.page.evaluate((value) => (window.__resize751.phase = value), value)
  const setSize = async (width, height) => {
    await live.app.evaluate(
      ({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(size.width, size.height),
      { width, height },
    )
    await live.page.waitForTimeout(35)
  }
  let sequence = 0
  const chunk = () => {
    const delta = " segment_" + ++sequence + " keeps streaming during native resize."
    const offset = state.text.length
    state.text += delta
    const payload = {
      type: "session.next.text.delta",
      properties: {
        sessionID: background,
        assistantMessageID: "msg_1001_" + background + "_assistant",
        textID: "text_resize751",
        delta,
        offset,
      },
    }
    for (const stream of streams) stream.write("data: " + JSON.stringify({ directory, payload }) + "\n\n")
  }
  streamTimer = setInterval(chunk, 40)
  await viewport.hover()
  await live.page.mouse.wheel(0, 10000)
  await live.page.waitForTimeout(120)
  await live.page.mouse.wheel(0, -320)
  await live.page.waitForTimeout(100)
  const latest = live.page.getByRole("button", { name: /latest/i }).first()
  await latest.click()
  report.followRequestedBy = "native down/up and actual jump-to-latest"
  await until(measure, (value) => value.distance <= 2, "explicit follow at real bottom")
  report.followBefore = await measure()
  if (mode !== "reading") {
    await phase("follow-narrow")
    for (let step = 1; step <= 18; step++) await setSize(1400 - step * 24, 900 - step * 12)
    await live.page.waitForTimeout(180)
    report.followAfter = await measure()
    await capture(live.app, "01-follow-narrow")
  }
  if (mode !== "gap") {
    await phase("reading-setup")
    await setSize(1400, 900)
    await live.page.waitForTimeout(180)
    await viewport.hover()
    await live.page.mouse.wheel(0, 10000)
    await live.page.waitForTimeout(100)
    report.readingBottom = await measure()
    await live.page.mouse.wheel(0, -500)
    await live.page.waitForTimeout(120)
    report.readingBefore = await measure()
    assert(report.readingBottom.top - report.readingBefore.top > 100, "real native wheel leaves bottom")
    const anchor = await viewport.evaluate((root) => {
      const top = root.getBoundingClientRect().top
      const node = [...root.querySelectorAll("p")].find(
        (node) => node.textContent?.startsWith("RESIZE_PARA_") && node.getBoundingClientRect().bottom > top + 10,
      )
      if (!node) throw Error("visible reading paragraph missing")
      return { text: node.textContent, offset: node.getBoundingClientRect().top - top }
    })
    report.readingAnchorBefore = anchor
    await phase("reading-narrow")
    for (let step = 1; step <= 18; step++) await setSize(1400 - step * 24, 900 - step * 12)
    await live.page.waitForTimeout(180)
    report.readingAfter = await measure()
    report.readingAnchorAfter = await viewport.evaluate((root, text) => {
      const node = [...root.querySelectorAll("p")].find((node) => node.textContent === text)
      return node ? { text, offset: node.getBoundingClientRect().top - root.getBoundingClientRect().top } : null
    }, anchor.text)
    await capture(live.app, "02-reading-narrow")
  }
  clearInterval(streamTimer)
  report.streamChunks = sequence
  report.trace = await live.page.evaluate(() => {
    window.__resize751.running = false
    return window.__resize751
  })
  const follow = report.trace.samples.filter((x) => x.phase === "follow-narrow")
  const reversals = follow
    .slice(1)
    .flatMap((item, i) =>
      item.width <= follow[i].width + 1 && item.viewport <= follow[i].viewport + 1 && item.top < follow[i].top - 2
        ? [{ previous: follow[i], current: item }]
        : [],
    )
  report.followSummary = {
    samples: follow.length,
    maxDistance: follow.length ? Math.max(...follow.map((x) => x.distance)) : null,
    backwardsJumps: reversals.length,
    reversals,
  }
  report.readingShift = report.readingAnchorAfter
    ? report.readingAnchorAfter.offset - report.readingAnchorBefore.offset
    : null
  await Promise.all([...gapTasks])
  await close(live.app)
  assert.deepEqual(report.pageErrors, [])
  assert.deepEqual(report.failedResponses, [])
  assert(sequence > 10, "text chunks arrived while native bounds changed")
  if (mode !== "reading") {
    assert.equal(reversals.length, 0, "narrowing while following never jumps upward against increasing content height")
    assert(report.followAfter.distance <= 2, "following stays at bottom after resize settles")
  }
  if (mode !== "gap") {
    assert(
      report.readingAnchorAfter && Math.abs(report.readingShift) <= 24,
      "native user-up keeps the same reading paragraph within one wrap line after resize",
    )
    assert(report.readingAfter.distance > 80, "resize does not force user-up reading to latest")
  }
  if (mode !== "reading") requireContinuousResizeFollow(follow)
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
  if (streamTimer) clearInterval(streamTimer)
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
  console.log(
    JSON.stringify({
      passed: report.passed,
      error: report.error,
      followSummary: report.followSummary,
      readingShift: report.readingShift,
      apps: report.apps,
      streamChunks: report.streamChunks,
    }),
  )
}
