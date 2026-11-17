import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { join, resolve, dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { expect } from "@playwright/test"
import { mainPath } from "./main-path.mjs"

const manifest = JSON.parse(await readFile(process.argv[2], "utf8"))
const record = resolve(process.argv[3])
assert(record.startsWith(resolve("F:/Zaovra-研发记录/逐次记录") + "\\"))
const desktop = resolve(import.meta.dirname, "..")
const digest = manifest.files.find((file) =>
  file.path.replaceAll("\\", "/").endsWith("/win-unpacked/resources/app.asar"),
)?.sha256
assert(digest, "manifest contains actual asar identity")
const options = {
  executable: join(desktop, "dist/win-unpacked/Zaovra Beta.exe"),
  record,
  source: manifest.sourceSHA,
  isolationRoot: dirname(record),
}
const result = { sourceSHA: manifest.sourceSHA, asarSHA256: digest, productAPI: 0, cycles: [], pass: false }
const run = await mainPath(options)
let reopened
let db
async function identity(instance) {
  assert.equal(instance.report.runtime.version, manifest.version)
  const appPath = await instance.desktop.evaluate(({ app }) => app.getAppPath())
  assert.equal(
    createHash("sha256")
      .update(await readFile(appPath))
      .digest("hex"),
    digest,
  )
  return { ...instance.report.runtime, appPath }
}
try {
  result.runtime = await identity(run)
  await run.fresh()
  await run.connect()
  await run.reply()
  const page = run.page
  const input = page.locator('[data-component="prompt-input"][contenteditable="true"]')
  const active = page.locator(
    '[data-component="desktop-sidebar-v2"] [data-slot="titlebar-tab-item"][data-active="true"] [data-slot="tab-link"]',
  )
  const href = await active.getAttribute("href")
  const session = /ses_[a-zA-Z0-9]+/.exec(href ?? "")?.[0]
  assert(session, "original Session identity")
  result.session = session
  db = new DatabaseSync(join(run.report.runtime.userData, "backend/data/zaovra/zaovra.db"), { readOnly: true })
  const messages = () => db.prepare("select id,type,data from session_message order by seq").all()
  const before = messages()
  assert(before.some((message) => message.type === "user"))
  await writeFile(join(record, "messages-before.json"), JSON.stringify(before, null, 2))
  const location = /\/api\/location(?:\?|$)/
  const failed = []
  page.on("requestfailed", (request) => {
    if (location.test(request.url())) failed.push({ url: request.url(), error: request.failure()?.errorText })
  })
  for (const cycle of [1, 2, 3]) {
    for (const fault of ["network", "server", "offline"]) {
      const observation = { cycle, fault, requests: [], pass: false }
      result.cycles.push(observation)
      let reject = true
      const route = async (route) => {
        observation.requests.push({ url: route.request().url(), rejected: reject })
        if (!reject || fault === "offline") return route.continue()
        if (fault === "network") return route.abort("failed")
        return route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ message: "temporary unavailable" }),
        })
      }
      await page.route(location, route)
      const failStart = failed.length
      if (fault === "offline") {
        await page.context().setOffline(true)
        await run.desktop.evaluate(async ({ BrowserWindow }) => {
          for (const window of BrowserWindow.getAllWindows()) await window.webContents.session.closeAllConnections()
        })
      }
      await page.getByRole("button", { name: "新对话", exact: true }).last().click()
      const status = page.getByRole("status").filter({ hasText: "请求失败" })
      await expect(status).toBeVisible()
      await expect(status).toContainText("Zaovra 项目")
      await expect(page.locator('[data-component="desktop-sidebar-v2"]')).toBeVisible()
      await expect(status.getByRole("button", { name: "从列表中移除", exact: true })).toHaveCount(0)
      const retries = observation.requests.length
      await status.getByRole("button", { name: "重试", exact: true }).click()
      await expect.poll(() => observation.requests.length).toBeGreaterThan(retries)
      await expect(status).toBeVisible()
      observation.failures = failed.slice(failStart)
      if (fault !== "server") assert(observation.failures.length > 0, "actual project request failed")
      await run.capture(`failure-${cycle}-${fault}`)
      reject = false
      await page.context().setOffline(false)
      await status.getByRole("button", { name: "重试", exact: true }).click()
      await expect(input).toBeVisible()
      await expect(status).toHaveCount(0)
      // Keep this draft nonempty so the next cycle creates a distinct draft.
      await input.fill(`UNSENT_DIRECTORY_${cycle}_${fault}`)
      await expect(input).toHaveText(`UNSENT_DIRECTORY_${cycle}_${fault}`)
      await run.capture(`recovered-${cycle}-${fault}`)
      await expect(input).toHaveText(`UNSENT_DIRECTORY_${cycle}_${fault}`)
      await page.unroute(location, route)
      await page.locator(`[data-component="desktop-sidebar-v2"] [data-slot="tab-link"][href*="${session}"]`).click()
      await expect(page.getByText("实时回复已到达", { exact: true })).toBeVisible()
      assert.deepEqual(messages(), before, "failed directory checks do not mutate durable messages")
      assert.equal(run.report.modelCalls, 1, "navigation and retries do not send model work")
      observation.pass = true
    }
  }
  const after = messages()
  await writeFile(join(record, "messages-after.json"), JSON.stringify(after, null, 2))
  assert.deepEqual(after, before)
  db.close()
  db = undefined
  await run.close()
  reopened = await mainPath({ ...options, record: record + "-reopened", profile: run.report.profile })
  result.reopenRuntime = await identity(reopened)
  await expect(reopened.page.getByText("实时回复已到达", { exact: true })).toBeVisible({ timeout: 90000 })
  db = new DatabaseSync(join(reopened.report.runtime.userData, "backend/data/zaovra/zaovra.db"), { readOnly: true })
  assert.deepEqual(messages(), before, "cold start preserves original messages")
  await reopened.capture("cold-original")
  result.pass = true
} catch (error) {
  result.failure = String(error)
  await (reopened ?? run).capture("directory-failure").catch(() => {})
  process.exitCode = 1
} finally {
  db?.close()
  await run.page
    .context()
    .setOffline(false)
    .catch(() => {})
  await run.close().catch((error) => {
    result.closeError = String(error)
    process.exitCode = 1
  })
  await reopened?.close().catch((error) => {
    result.reopenCloseError = String(error)
    process.exitCode = 1
  })
  result.closed = run.report.closed && (!reopened || reopened.report.closed)
  result.modelCalls = run.report.modelCalls + (reopened?.report.modelCalls ?? 0)
  await writeFile(join(record, "directory-result.json"), JSON.stringify(result, null, 2))
  console.log(
    JSON.stringify({
      pass: result.pass,
      cycles: result.cycles.filter((cycle) => cycle.pass).length,
      closed: result.closed,
      modelCalls: result.modelCalls,
      failure: result.failure,
    }),
  )
}
