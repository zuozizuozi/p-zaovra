import assert from "node:assert/strict"
import { mkdir, writeFile, readFile, stat } from "node:fs/promises"
import { createServer } from "node:http"
import { isAbsolute, join, resolve } from "node:path"
import { _electron } from "playwright-core"

// Packaged Dev fixture at 0.1.1-beta.12; prior version is seeded in isolated storage.
// No real Beta installation/upgrade or ordinary user profile is accessed.
const executable = resolve(process.argv[2] ?? "")
const record = resolve(process.argv[3] ?? "")
const locale = process.argv[4] === "en" ? "en" : "zh"
const development = process.argv[5] === "--development"
const current = process.argv.includes("--current")
const currentNotes = current
  ? JSON.parse(await readFile(new URL("../../app-ui/src/release-notes/current.json", import.meta.url), "utf8"))
  : undefined
const currentVersion = currentNotes?.version ?? "0.1.1-beta.12"
if (current) assert.match(currentVersion, /^\d+\.\d+\.\d+-beta\.[1-9]\d*$/)
const disabledTail = process.argv.includes("--disabled-tail")
assert(process.argv[2] && process.argv[3] && isAbsolute(executable) && isAbsolute(record))
assert.equal(
  await stat(record).then(
    () => true,
    () => false,
  ),
  false,
  "new evidence/profile directory",
)
await mkdir(record, { recursive: true })
const requests = []
const fixture = createServer(async (request, response) => {
  let body = ""
  for await (const chunk of request) body += chunk
  requests.push({ method: request.method, path: request.url, bytes: Buffer.byteLength(body) })
  if (request.url !== "/v1/chat/completions" || request.method !== "POST") {
    response.writeHead(404).end()
    return
  }
  const chunk = (delta, finish_reason = null) =>
    JSON.stringify({
      id: "fixture697",
      object: "chat.completion.chunk",
      created: 1,
      model: "fixture",
      choices: [{ index: 0, delta, finish_reason }],
    })
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
  response.end(
    "data: " +
      chunk({ role: "assistant", content: "Fixed local response." }) +
      "\n\ndata: " +
      chunk({}, "stop") +
      "\n\ndata: [DONE]\n\n",
  )
})
await new Promise((done) => fixture.listen(0, "127.0.0.1", done))
const env = Object.fromEntries(
  ["SystemRoot", "WINDIR", "COMSPEC", "PATH", "PATHEXT"].flatMap((key) =>
    process.env[key] ? [[key, process.env[key]]] : [],
  ),
)
for (const [key, dir] of Object.entries({
  HOME: "home",
  USERPROFILE: "home",
  APPDATA: "config",
  LOCALAPPDATA: "cache",
  XDG_CONFIG_HOME: "config",
  XDG_DATA_HOME: "data",
  XDG_STATE_HOME: "state",
  XDG_CACHE_HOME: "cache",
  TEMP: "temp",
  TMP: "temp",
  TMPDIR: "temp",
})) {
  env[key] = join(record, dir)
  await mkdir(env[key], { recursive: true })
}
env.ZAOVRA_TEST_ONBOARDING = "1"
if (current) env.ZAOVRA_DISABLE_MODELS_FETCH = "true"
const profile = join(record, "temp", "explicit-profile")
const config = join(profile, "desktop", "backend", "config", "zaovra")
const summary = {
  executable,
  locale,
  assertions: {},
  stopped: false,
  model: "loopback fixed response; no paid model or user key",
  fixtureRequests: requests,
  pageErrors: [],
  failedResponses: [],
  sessionMutations: [],
}
let desktop
let exited
let phase = 0
let observation = 0
summary.exits = []
summary.runtimes = []
async function ownership() {
  const id = phase + "-" + ++observation
  const processes = await desktop.evaluate(({ app }) =>
    app.getAppMetrics().map((item) => ({ pid: item.pid, type: item.type })),
  )
  await writeFile(join(record, "processes-" + id + ".json"), JSON.stringify(processes, null, 2))
  if (process.env.ZAOVRA_FIRST_LAUNCH_TRACK_OWNERSHIP !== "1") return
  const deadline = Date.now() + 5_000
  while (
    !(await stat(join(record, "processes-" + id + "-ack.json")).then(
      () => true,
      () => false,
    ))
  ) {
    assert(Date.now() < deadline, "ownership recorder acknowledgement")
    await new Promise((done) => setTimeout(done, 25))
  }
}

await mkdir(config, { recursive: true })
await mkdir(join(profile, "desktop", "backend", "data", "zaovra"), { recursive: true })
await writeFile(
  join(profile, "desktop", "backend", "upgrade.json"),
  JSON.stringify({ version: 1, channel: "dev", action: "empty" }),
)
await writeFile(
  join(config, "zaovra.json"),
  JSON.stringify({
    model: "fixture697/fixture",
    snapshot: false,
    enabled_providers: ["fixture697"],
    provider: {
      fixture697: {
        name: "Local fixture",
        env: [],
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: "http://127.0.0.1:PORT/v1", apiKey: "fixture-not-a-secret" },
        models: {
          fixture: {
            name: "Fixed local response",
            tool_call: true,
            modalities: { input: ["text"], output: ["text"] },
            limit: { context: 32000, output: 2048 },
          },
        },
      },
    },
  }).replace("PORT", String(fixture.address().port)),
)
async function launch() {
  phase++
  desktop = await _electron.launch({
    executablePath: executable,
    args: [
      ...(development ? [resolve(".")] : []),
      "--user-data-dir=" + profile,
      "--lang=" + (locale === "zh" ? "zh-CN" : "en-US"),
    ],
    env,
    timeout: 90_000,
  })
  const child = desktop.process()
  await writeFile(join(record, "electron-start-" + phase + ".json"), JSON.stringify({ pid: child.pid }))
  exited = new Promise((done) => child.once("exit", (code, signal) => done({ code, signal })))
  const runtime = await desktop.evaluate(({ app }) => ({
    packaged: app.isPackaged,
    version: app.getVersion(),
    userData: app.getPath("userData"),
    documents: app.getPath("documents"),
    home: app.getPath("home"),
  }))
  summary.runtimes.push(runtime)
  assert.equal(runtime.packaged, !development)
  assert.equal(runtime.version, currentVersion)
  for (const dir of [runtime.userData, runtime.documents, runtime.home])
    assert(resolve(dir).startsWith(record + "/") || resolve(dir).startsWith(record + "\\"), "isolated runtime paths")
  const page = await desktop.firstWindow({ timeout: 90_000 })
  page.setDefaultTimeout(30_000)
  page.on("pageerror", (error) => summary.pageErrors.push(error.stack ?? error.message))
  page.on("response", (response) => {
    if (response.status() >= 400)
      summary.failedResponses.push({ path: new URL(response.url()).pathname, status: response.status() })
  })
  await desktop.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    win.setSize(1400, 900)
    win.setTitle("Zaovra Release710 isolated")
  })
  await ownership()
  return page
}
async function stop() {
  if (!desktop) return
  await ownership()
  await desktop.close()
  const exit = await exited
  summary.exits.push(exit)
  desktop = undefined
  assert.equal(exit.signal, null)
  assert.equal(exit.code, 0)
}
async function store(page, key) {
  return page.evaluate(async (key) => JSON.parse(await window.api.storeGet("default.dat", key)), key)
}
async function priorVersion(page) {
  const previous = current ? currentVersion.replace(/\d+$/, (n) => String(Number(n) - 1)) : "0.1.1-beta.11"
  await page.evaluate(async (previous) => {
    await window.api.storeSet("default.dat", "highlights.v1", JSON.stringify({ version: previous }))
    await window.api.storeSet("default.dat", "app-version.v1", JSON.stringify({ version: previous }))
  }, previous)
}
async function ready(page) {
  await page
    .locator('[data-component="prompt-input"][contenteditable="true"]')
    .waitFor({ state: "visible", timeout: 90_000 })
  await page.waitForFunction(
    async (version) => JSON.parse(await window.api.storeGet("default.dat", "highlights.v1"))?.version === version,
    currentVersion,
  )
}
const title = locale === "zh" ? `${currentVersion} 更新内容` : `What’s new in ${currentVersion}`
const titles = current
  ? currentNotes[locale].map((item) => item.title)
  : locale === "zh"
    ? ["回复不再卡住", "任务中可以插话", "模型列表更清楚", "侧栏右键可重命名", "权限卡片更紧凑"]
    : [
        "Replies no longer get stuck",
        "Steer a running task",
        "Cleaner model picker",
        "Rename from the sidebar",
        "Compact permission cards & PDF support",
      ]
const notes = (page) => page.getByRole("dialog").filter({ has: page.getByText(title, { exact: true }) })
async function openSettings(page) {
  await page.keyboard.press("Control+,")
  await page.locator('[data-action="view-release-notes"]').waitFor({ state: "visible" })
}
try {
  if (current) {
    let page = await launch()
    await ready(page)
    assert.equal(await notes(page).count(), 0, "new install does not auto-open current notes")
    summary.assertions.currentFreshQuiet = true
    await page.keyboard.press("Control+,")
    await page.getByRole("tab", { name: locale === "zh" ? "关于 Zaovra" : "About Zaovra", exact: true }).click()
    const about = page.getByRole("button", {
      name: locale === "zh" ? "查看本版更新内容" : "View this version’s release notes",
      exact: true,
    })
    await about.waitFor({ state: "visible" })
    await page.screenshot({ path: join(record, "current-about-entry.png") })
    await about.click()
    await notes(page).waitFor({ state: "visible" })
    for (let i = 0; i < titles.length; i++) {
      await notes(page).getByText(titles[i], { exact: true }).waitFor({ state: "visible" })
      await notes(page).getByText(currentNotes[locale][i].description, { exact: true }).waitFor({ state: "visible" })
      await page.screenshot({ path: join(record, "current-about-item-" + i + ".png") })
    }
    await notes(page)
      .getByRole("button", { name: locale === "zh" ? "知道了" : "Got it", exact: true })
      .click()
    await notes(page).waitFor({ state: "hidden" })
    summary.assertions.aboutAllCurrentNotes = true
    await priorVersion(page)
    await stop()
    page = await launch()
    await ready(page)
    await notes(page).waitFor({ state: "visible" })
    summary.assertions.currentVersionChangeAutoPopup = true
    await page.screenshot({ path: join(record, "current-auto-popup.png") })
    for (let i = 0; i < titles.length; i++) {
      await notes(page).getByText(titles[i], { exact: true }).waitFor({ state: "visible" })
    }
    await notes(page)
      .getByRole("button", { name: locale === "zh" ? "知道了" : "Got it", exact: true })
      .click()
    await notes(page).waitFor({ state: "hidden" })
    summary.assertions.currentAutoAllItems = true
    await stop()
    if (locale === "zh") {
      page = await launch()
      await ready(page)
      assert.equal(await notes(page).count(), 0, "dismissed current version quiet after restart")
      summary.assertions.currentRepeatQuiet = true
      await page.screenshot({ path: join(record, "current-restart-quiet.png") })
      await stop()
    }
  }
  if (!current && !disabledTail) {
    let page = await launch()
    await ready(page)
    assert.equal(await notes(page).count(), 0, "fresh install has no automatic popup")
    summary.assertions.freshQuiet = true
    await page.screenshot({ path: join(record, "fresh-no-popup.png") })
    await priorVersion(page)
    await stop()

    page = await launch()
    await ready(page)
    await notes(page).waitFor({ state: "visible" })
    assert.equal(await notes(page).getByText(titles[0], { exact: true }).isVisible(), true)
    assert.equal(
      await notes(page)
        .getByText(/请重点测|Please focus testing here/)
        .count(),
      0,
    )
    await page.screenshot({ path: join(record, "upgrade-popup.png") })
    for (const heading of titles.slice(1)) {
      await notes(page).getByText(heading, { exact: true }).waitFor({ state: "visible" })
    }
    await notes(page)
      .getByRole("button", { name: locale === "zh" ? "知道了" : "Got it", exact: true })
      .click()
    await notes(page).waitFor({ state: "hidden" })
    summary.assertions.upgradeAndAllFive = true
    await page.screenshot({ path: join(record, "closed-no-popup.png") })
    assert.equal((await store(page, "highlights.v1")).version, currentVersion)
    await stop()

    if (locale === "zh") {
      page = await launch()
      await ready(page)
      assert.equal(await notes(page).count(), 0, "dismissed current version is quiet after restart")
      summary.assertions.repeatQuiet = true
      await page.screenshot({ path: join(record, "restart-no-popup.png") })
      await openSettings(page)
      await page.locator('[data-action="view-release-notes"]').click()
      await notes(page).waitFor({ state: "visible" })
      await page.screenshot({ path: join(record, "settings-reopened.png") })
      summary.assertions.settingsReopen = true
      await notes(page).getByRole("button", { name: "不再显示", exact: true }).click()
      await notes(page).waitFor({ state: "hidden" })
      assert.equal((await store(page, "settings.v3")).general.releaseNotes, false)
      await priorVersion(page)
      await stop()

      page = await launch()
      await ready(page)
      assert.equal(await notes(page).count(), 0, "disabled preference suppresses the next version change")
      await openSettings(page)
      await page.locator('[data-action="view-release-notes"]').click()
      await notes(page).waitFor({ state: "visible" })
      assert.equal((await store(page, "settings.v3")).general.releaseNotes, false)
      await page.screenshot({ path: join(record, "disabled-manual-reopened.png") })
      summary.assertions.disablePersistsAndManualStillWorks = true
      await notes(page).locator('[data-slot="dialog-close-button"]').click()
      await notes(page).waitFor({ state: "hidden" })
      await stop()
    }
  }
  if (!current && disabledTail) {
    // New isolated fixture for the previously unexecuted disabled-preference tail only.
    let page = await launch()
    await ready(page)
    await page.evaluate(async () => {
      const settings = JSON.parse(await window.api.storeGet("default.dat", "settings.v3"))
      settings.general.releaseNotes = false
      await window.api.storeSet("default.dat", "settings.v3", JSON.stringify(settings))
    })
    await priorVersion(page)
    await stop()
    page = await launch()
    await ready(page)
    assert.equal(await notes(page).count(), 0, "disabled preference suppresses a version change")
    await openSettings(page)
    await page.locator('[data-action="view-release-notes"]').click()
    await notes(page).waitFor({ state: "visible" })
    assert.equal((await store(page, "settings.v3")).general.releaseNotes, false)
    await page.screenshot({ path: join(record, "disabled-manual-reopened.png") })
    await notes(page).locator('[data-slot="dialog-close-button"]').click()
    await notes(page).waitFor({ state: "hidden" })
    summary.assertions.disablePersistsAndManualStillWorks = true
    await stop()
  }
  assert.equal(requests.length, 0, "release notes do not make a model request")
  assert.equal(summary.pageErrors.length, 0, "no renderer page errors")
  assert.equal(summary.failedResponses.length, 0, "no failed app responses")
} catch (error) {
  summary.error = { name: error.name, message: error.message }
  throw error
} finally {
  try {
    if (desktop) {
      const page = desktop.windows()[0]
      if (page && !page.isClosed()) {
        await page.screenshot({ path: join(record, "final.png") })
        await writeFile(join(record, "visible-ui-final.txt"), await page.locator("body").innerText())
      }
      await stop()
    }
  } finally {
    await new Promise((done) => fixture.close(done))
    summary.stopped = !desktop
    await writeFile(join(record, "result.json"), JSON.stringify(summary, null, 2) + "\n")
    await writeFile(join(record, "finish.json"), JSON.stringify({ stopped: summary.stopped }))
  }
}
console.log(JSON.stringify(summary))
