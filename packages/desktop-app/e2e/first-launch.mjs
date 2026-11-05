import assert from "node:assert/strict"
import { mkdir, writeFile, stat } from "node:fs/promises"
import { isAbsolute, join, resolve } from "node:path"
import { _electron } from "playwright-core"

// Run against an unpacked desktop artifact, never a user's installed profile.
// node e2e/first-launch.mjs <executable> <new-record-directory>
const executable = resolve(process.argv[2] ?? "")
const record = resolve(process.argv[3] ?? "")
assert(process.argv[2] && process.argv[3] && isAbsolute(executable) && isAbsolute(record))
assert.equal(
  await stat(record).then(
    () => true,
    () => false,
  ),
  false,
  "record/profile must be new",
)
await mkdir(record, { recursive: true })
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
const desktop = await _electron.launch({
  executablePath: executable,
  args: ["--user-data-dir=" + join(record, "explicit-profile"), "--lang=zh-CN"],
  env,
  timeout: 90_000,
})
const child = desktop.process()
await writeFile(join(record, "electron-start.json"), JSON.stringify({ pid: child.pid }))
const exited = new Promise((done) => child.once("exit", (code, signal) => done({ code, signal })))
const summary = { executable, pid: child.pid, packaged: false, assertions: {}, stopped: false }
try {
  const runtime = await desktop.evaluate(({ app }) => ({
    packaged: app.isPackaged,
    version: app.getVersion(),
    userData: app.getPath("userData"),
    documents: app.getPath("documents"),
    home: app.getPath("home"),
  }))
  Object.assign(summary, runtime)
  assert.equal(runtime.packaged, true, "must test the actual packaged artifact")
  for (const dir of [runtime.userData, runtime.documents, runtime.home]) {
    assert(resolve(dir).startsWith(record + "/") || resolve(dir).startsWith(record + "\\"), "isolated paths only")
  }
  const page = await desktop.firstWindow({ timeout: 90_000 })
  page.setDefaultTimeout(90_000)
  await page.locator('[data-component="prompt-input"][contenteditable="true"]').waitFor({ state: "visible" })
  const sidebar = page.locator('[data-component="desktop-sidebar-v2"]')
  summary.oldLayoutEligible = await page.evaluate(() => window.api.isOldLayoutEligible())
  summary.firstLaunchPending = await page.evaluate(() => window.api.isFirstLaunchOnboardingPending())
  await sidebar.waitFor({ state: "visible" })
  assert(await sidebar.isVisible(), "main sidebar")
  assert(await sidebar.locator("svg").first().isVisible(), "ZAOVRA wordmark")
  assert.match(await sidebar.locator('[data-slot="project-heading"]').first().innerText(), /Default Project/)
  const draft = sidebar
    .locator('[data-slot="titlebar-tab-item"][data-active="true"]')
    .filter({ has: page.locator('a[href*="draftId="]') })
  await draft.waitFor({ state: "visible" })
  assert.equal(await draft.count(), 1, "fresh profile opens one active draft tab")
  assert.match(await draft.innerText(), /新对话|新会话|New (chat|session)/i)
  assert.match(await page.locator('[data-slot="new-session-task"]').innerText(), /Default Project/)
  assert.equal(await page.getByText(/欢迎使用 Zaovra|Welcome to Zaovra|Zaovra 0\.1\.0/).count(), 0)
  assert.equal(await page.getByRole("dialog").count(), 0, "no release-notes modal")
  assert((await stat(join(runtime.documents, "Default Project"))).isDirectory())
  summary.assertions = {
    sidebar: true,
    logo: true,
    project: true,
    activeDraft: true,
    projectTitle: true,
    input: true,
    noWelcome: true,
    noReleaseNotes: true,
  }
  await page.screenshot({ path: join(record, "first-launch.png") })
  await writeFile(join(record, "visible-ui.txt"), await page.locator("body").innerText())
  await writeFile(
    join(record, "draft-links.json"),
    JSON.stringify(
      await draft.locator("a").evaluateAll((links) => links.map((link) => link.getAttribute("href"))),
      null,
      2,
    ),
  )
  const input = page.locator('[data-component="prompt-input"][contenteditable="true"]')
  await input.fill("首启无模型保护验证")
  await input.press("Enter")
  await page.getByText("所选模型当前不可用", { exact: true }).waitFor({ state: "visible" })
  assert.match(await input.innerText(), /首启无模型保护验证/)
  summary.assertions.noModelSendPrompt = true
  await page.screenshot({ path: join(record, "no-model-send.png") })
} finally {
  try {
    const page = desktop.windows()[0]
    if (page && !page.isClosed()) {
      await page.screenshot({ path: join(record, "first-launch-final.png") })
      await writeFile(join(record, "visible-ui-final.txt"), await page.locator("body").innerText())
    }
    const processes = await desktop.evaluate(({ app }) =>
      app.getAppMetrics().map((item) => ({ pid: item.pid, type: item.type })),
    )
    await writeFile(join(record, "processes.json"), JSON.stringify(processes, null, 2))
    if (process.env.ZAOVRA_FIRST_LAUNCH_TRACK_OWNERSHIP === "1") {
      const deadline = Date.now() + 5_000
      while (
        !(await stat(join(record, "processes-ack.json")).then(
          () => true,
          () => false,
        ))
      ) {
        assert(Date.now() < deadline, "ownership recorder acknowledgement")
        await new Promise((done) => setTimeout(done, 25))
      }
    }
  } finally {
    await desktop.close()
    summary.exit = await exited
    summary.stopped = true
    await writeFile(join(record, "result.json"), JSON.stringify(summary, null, 2) + "\n")
  }
}
assert.equal(summary.exit.signal, null)
assert.equal(summary.exit.code, 0)
console.log(JSON.stringify({ packaged: summary.packaged, assertions: summary.assertions, exit: summary.exit }))
