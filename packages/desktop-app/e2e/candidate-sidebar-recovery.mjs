import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { createServer, request } from "node:http"
import { expect } from "@playwright/test"
import { mainPath } from "./main-path.mjs"

// Miss the completion while the real backend finishes, by removing the renderer
// or disconnecting its network. No fake history or notification state is used.
const manifest = JSON.parse(await readFile(process.argv[2], "utf8"))
const record = resolve(process.argv[3])
const mode = process.argv[4] ?? "renderer"
assert(["renderer", "disconnect"].includes(mode))
const desktop = resolve(import.meta.dirname, "..")
const asar = join(desktop, "dist/win-unpacked/resources/app.asar")
const hash = createHash("sha256")
  .update(await readFile(asar))
  .digest("hex")
assert.equal(
  hash,
  manifest.files.find((file) => file.path.replaceAll("\\", "/").endsWith("/win-unpacked/resources/app.asar"))?.sha256,
)
const result = { sourceSHA: manifest.sourceSHA, asarSHA256: hash, mode, productAPI: 0, pass: false, checkpoints: [] }
const finish = Promise.withResolvers()
const finalText = mode === "disconnect" ? "实时回复已到达；断线期间完成内容" : "实时回复已到达"
const run = await mainPath({
  executable: join(desktop, "dist/win-unpacked/Zaovra Beta.exe"),
  record,
  source: manifest.sourceSHA,
  respond: mode === "disconnect" ? disconnectedReply : undefined,
})

async function disconnectedReply(body, response) {
  assert.equal(body.stream, true)
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
  const send = (delta, finish_reason = null) =>
    response.write(
      "data: " +
        JSON.stringify({
          id: "sidebar-disconnected-reply",
          object: "chat.completion.chunk",
          created: 1,
          model: "mp-returned",
          choices: [{ index: 0, delta, finish_reason }],
        }) +
        "\n\n",
    )
  send({ role: "assistant", content: "实时回复已到达" })
  await finish.promise
  if (response.destroyed) return
  send({ content: "；断线期间完成内容" })
  send({}, "stop")
  response.end("data: [DONE]\n\n")
}
let db
const streams = new Set()
const sockets = new Set()
const network = { blocked: false, connected: 0, disconnected: 0, rejected: 0 }
const proxy = createServer((incoming, outgoing) => {
  const target = new URL(incoming.url)
  if (target.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)) {
    outgoing.writeHead(403).end()
    return
  }
  const event = target.pathname.endsWith("/event")
  if (event && network.blocked) {
    network.rejected++
    outgoing.writeHead(503).end()
    return
  }
  const upstream = request(target, { method: incoming.method, headers: incoming.headers }, (response) => {
    outgoing.writeHead(response.statusCode, response.headers)
    response.pipe(outgoing)
  })
  upstream.on("error", () => outgoing.destroy())
  incoming.pipe(upstream)
  const stream = { upstream, outgoing }
  if (event) {
    network.connected++
    streams.add(stream)
  }
  outgoing.on("close", () => {
    upstream.destroy()
    if (streams.delete(stream)) network.disconnected++
  })
})
proxy.on("connection", (socket) => {
  sockets.add(socket)
  socket.on("close", () => sockets.delete(socket))
})
try {
  const failures = []
  result.networkFailures = failures
  run.page.on("requestfailed", (request) => {
    const path = new URL(request.url()).pathname
    if (path.endsWith("/event")) failures.push({ path, error: request.failure()?.errorText })
  })
  assert.equal(run.report.runtime.version, manifest.version)
  const loaded = await run.desktop.evaluate(({ app }) => app.getAppPath())
  assert.equal(
    createHash("sha256")
      .update(await readFile(loaded))
      .digest("hex"),
    hash,
  )
  result.runtime = { ...run.report.runtime, appPath: loaded }
  await run.fresh()
  await run.connect()
  if (mode === "disconnect") {
    await new Promise((done) => proxy.listen(0, "127.0.0.1", done))
    await run.desktop.evaluate(
      async ({ webContents }, options) => {
        const contents = webContents.getAllWebContents().filter((item) => item.getURL() === options.url)
        if (contents.length !== 1) throw new Error(`Expected one test renderer, found ${contents.length}`)
        await contents[0].session.setProxy({
          mode: "fixed_servers",
          proxyRules: `http=127.0.0.1:${options.port}`,
          proxyBypassRules: "<-loopback>",
        })
      },
      { url: run.page.url(), port: proxy.address().port },
    )
    await run.page.reload()
    await expect.poll(() => streams.size, { timeout: 10000 }).toBeGreaterThan(0)
  }
  db = new DatabaseSync(join(run.report.runtime.userData, "backend/data/zaovra/zaovra.db"), { readOnly: true })
  const notification = async () => {
    const data = JSON.parse(await readFile(join(run.report.runtime.userData, "zaovra.global.dat"), "utf8"))
    return Object.values(data)
      .filter((value) => typeof value === "string" && value.includes("pendingCompletions"))
      .map((value) => JSON.parse(value))
  }
  const input = run.page.locator('[data-component="prompt-input"][contenteditable="true"]')
  await input.fill("MP4：结束事件错过后恢复待查看")
  await input.press("Enter")
  await run.page.getByText("实时回复已到达", { exact: true }).waitFor()
  const active = run.page.locator(
    '[data-component="desktop-sidebar-v2"] [data-slot="titlebar-tab-item"][data-active="true"] [data-slot="tab-link"]',
  )
  const session = /ses_[a-zA-Z0-9]+/.exec((await active.getAttribute("href")) ?? "")?.[0]
  assert(session)
  result.session = session
  const row = run.page
    .locator('[data-component="desktop-sidebar-v2"] [data-slot="titlebar-tab-item"]')
    .filter({ has: run.page.locator('a[href*="' + session + '"]') })
  await row.locator('[data-slot="session-running-ring"]').waitFor()
  await run.page.getByRole("button", { name: "新对话", exact: true }).last().click()
  await run.page.getByText("实时回复已到达", { exact: true }).waitFor({ state: "hidden" })
  await expect
    .poll(async () => (await notification()).some((value) => value.pendingCompletions[session]), { timeout: 10000 })
    .toBeTruthy()
  result.checkpoints.push({ phase: "busy-persisted", notification: await notification() })
  const url = run.page.url()
  const timeOrigin = await run.page.evaluate(() => performance.timeOrigin)
  await run.capture("01-background-busy")
  if (mode === "renderer") {
    await run.page.goto("about:blank")
    assert.equal(run.page.url(), "about:blank")
    assert.equal(await run.page.locator('[data-component="desktop-sidebar-v2"]').count(), 0)
  }
  if (mode === "disconnect") {
    const before = failures.length
    const disconnected = network.disconnected
    assert(streams.size > 0, "actual event stream traverses the loopback proxy")
    network.blocked = true
    for (const stream of streams) {
      stream.upstream.destroy()
      stream.outgoing.destroy()
    }
    await expect.poll(() => network.disconnected).toBeGreaterThan(disconnected)
    await expect.poll(() => failures.length, { timeout: 10000 }).toBeGreaterThan(before)
    await expect.poll(() => network.rejected, { timeout: 10000 }).toBeGreaterThan(0)
    assert.equal(await run.page.evaluate(() => performance.timeOrigin), timeOrigin)
    await expect(run.page.locator('[data-component="desktop-sidebar-v2"]')).toBeVisible()
    result.checkpoints.push({
      phase: "event-stream-disconnected",
      failures: failures.slice(before),
      timeOrigin,
      network: { ...network },
    })
  }
  run.control.stream.resolve()
  finish.resolve()
  const completed = () =>
    db
      .prepare("select id,data from session_message where session_id=? and type='assistant' order by seq")
      .all(session)
      .map((message) => ({ id: message.id, ...JSON.parse(message.data) }))
      .filter((message) => message.time.completed && message.finish === "stop")
  await expect.poll(() => completed().length, { timeout: 10000 }).toBe(1)
  const completion = completed()[0]
  assert.equal(
    completion.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join(""),
    finalText,
  )
  const absent = await notification()
  assert(absent.some((value) => value.pendingCompletions[session]))
  assert.equal(
    absent.flatMap((value) => value.list).filter((value) => value.session === session && value.type === "turn-complete")
      .length,
    0,
  )
  result.checkpoints.push({
    phase: mode === "renderer" ? "backend-completed-without-renderer" : "backend-completed-while-offline",
    url: run.page.url(),
    completion,
    notification: absent,
  })
  if (mode === "renderer") await run.page.goto(url)
  if (mode === "disconnect") network.blocked = false
  await row.locator('[data-slot="session-unread-dot"]').waitFor({ timeout: 15000 })
  if (mode === "disconnect") {
    assert.equal(run.page.url(), url)
    assert.equal(await run.page.evaluate(() => performance.timeOrigin), timeOrigin)
    assert(streams.size > 0, "real event stream reconnected")
  }
  assert.equal(await row.locator('[data-slot="session-running-ring"]').count(), 0)
  assert.notEqual(await row.getAttribute("data-active"), "true")
  const notices = async () =>
    (await notification())
      .flatMap((value) => value.list)
      .filter((value) => value.session === session && value.type === "turn-complete")
  await expect.poll(async () => (await notices()).length).toBe(1)
  assert.equal((await notices())[0].completion, completion.id)
  result.checkpoints.push({ phase: "restored-unread", notification: await notification() })
  await run.capture("02-recovered-unread")
  await run.page.reload()
  await row.locator('[data-slot="session-unread-dot"]').waitFor()
  assert.equal((await notices()).length, 1)
  result.checkpoints.push({ phase: "reload-no-duplicate", notification: await notification() })
  await row.locator('[data-slot="tab-link"]').click()
  await run.page.getByText(finalText, { exact: true }).waitFor()
  await expect(row.locator('[data-slot="session-unread-dot"]')).toHaveCount(0)
  await expect.poll(async () => (await notices())[0]?.viewed).toBe(true)
  await run.page.reload()
  await run.page.getByText(finalText, { exact: true }).waitFor()
  assert.equal(await row.locator('[data-slot="session-unread-dot"]').count(), 0)
  assert.equal(await row.locator('[data-slot="session-running-ring"]').count(), 0)
  assert.equal((await notices()).length, 1)
  assert.equal((await notices())[0].viewed, true)
  result.checkpoints.push({ phase: "viewed-reload-stays-read", notification: await notification() })
  await run.capture("03-viewed-reloaded")
  result.pass = true
} catch (error) {
  result.error = { message: String(error), stack: error.stack }
  await run.capture("failure").catch(() => {})
  process.exitCode = 1
} finally {
  finish.resolve()
  db?.close()
  await run.close().catch((error) => {
    result.closeError = String(error)
    result.pass = false
    process.exitCode = 1
  })
  for (const socket of sockets) socket.destroy()
  if (proxy.listening) await new Promise((done) => proxy.close(done))
  result.network = { ...network, activeStreams: streams.size, activeSockets: sockets.size }
  result.mainPath = run.report
  await writeFile(join(record, "sidebar-recovery.json"), JSON.stringify(result, null, 2))
  console.log(
    JSON.stringify({
      pass: result.pass,
      checkpoints: result.checkpoints.length,
      closed: run.report.closed,
      error: result.error,
    }),
  )
}
