import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { expect } from "@playwright/test"
import { mainPath } from "./main-path.mjs"

// Remove the renderer while the real backend finishes. No fake history, events,
// notification state or backend restart is used to manufacture recovery.
const manifest = JSON.parse(await readFile(process.argv[2], "utf8"))
const record = resolve(process.argv[3])
const desktop = resolve(import.meta.dirname, "..")
const asar = join(desktop, "dist/win-unpacked/resources/app.asar")
const hash = createHash("sha256")
  .update(await readFile(asar))
  .digest("hex")
assert.equal(
  hash,
  manifest.files.find((file) => file.path.replaceAll("\\", "/").endsWith("/win-unpacked/resources/app.asar"))?.sha256,
)
const result = { sourceSHA: manifest.sourceSHA, asarSHA256: hash, productAPI: 0, pass: false, checkpoints: [] }
const run = await mainPath({
  executable: join(desktop, "dist/win-unpacked/Zaovra Beta.exe"),
  record,
  source: manifest.sourceSHA,
})
let db
try {
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
  await run.capture("01-background-busy")
  // A blank document cannot consume the backend's terminal event. The packaged
  // main process and its backend remain alive; durable completion is read below.
  await run.page.goto("about:blank")
  assert.equal(run.page.url(), "about:blank")
  assert.equal(await run.page.locator('[data-component="desktop-sidebar-v2"]').count(), 0)
  run.control.stream.resolve()
  const completed = () =>
    db
      .prepare("select id,data from session_message where session_id=? and type='assistant' order by seq")
      .all(session)
      .map((message) => ({ id: message.id, ...JSON.parse(message.data) }))
      .filter((message) => message.time.completed && message.finish === "stop")
  await expect.poll(() => completed().length, { timeout: 10000 }).toBe(1)
  const completion = completed()[0]
  const absent = await notification()
  assert(absent.some((value) => value.pendingCompletions[session]))
  assert.equal(
    absent.flatMap((value) => value.list).filter((value) => value.session === session && value.type === "turn-complete")
      .length,
    0,
  )
  result.checkpoints.push({
    phase: "backend-completed-without-renderer",
    url: run.page.url(),
    completion,
    notification: absent,
  })
  await run.page.goto(url)
  await row.locator('[data-slot="session-unread-dot"]').waitFor({ timeout: 15000 })
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
  await run.page.getByText("实时回复已到达", { exact: true }).waitFor()
  await expect(row.locator('[data-slot="session-unread-dot"]')).toHaveCount(0)
  await expect.poll(async () => (await notices())[0]?.viewed).toBe(true)
  await run.page.reload()
  await run.page.getByText("实时回复已到达", { exact: true }).waitFor()
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
  db?.close()
  await run.close().catch((error) => {
    result.closeError = String(error)
    result.pass = false
    process.exitCode = 1
  })
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
