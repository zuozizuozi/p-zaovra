import assert from "node:assert/strict"
import { mkdir, writeFile, stat, readFile } from "node:fs/promises"
import { isAbsolute, join, resolve } from "node:path"
import { _electron } from "playwright-core"

const executable = resolve(process.argv[2] ?? "")
const record = resolve(process.argv[3] ?? "")
const scenario = process.argv[4] ?? "fresh-zh"
const locale = scenario.endsWith("en") ? "en" : "zh"
assert(process.argv[2] && process.argv[3] && isAbsolute(executable) && isAbsolute(record))
assert.equal(
  await stat(record).then(
    () => true,
    () => false,
  ),
  false,
  "new evidence/profile",
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
const profile = join(record, "temp", "explicit-profile")
const folder = scenario.startsWith("legacy") ? "Default Project" : locale === "zh" ? "Zaovra 项目" : "Zaovra Projects"
const directory = join(profile, "documents", folder)
if (scenario.startsWith("legacy")) {
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, "keep.txt"), "existing user work")
}
const summary = {
  scenario,
  locale,
  executable,
  directory,
  pageErrors: [],
  runtimes: [],
  exits: [],
  screenshots: [],
  modelRequests: 0,
  stopped: false,
}
let desktop
let exited
let phase = 0
let observation = 0
async function ownership() {
  const processes = await desktop.evaluate(({ app }) =>
    app.getAppMetrics().map((item) => ({ pid: item.pid, type: item.type })),
  )
  const name = "processes-" + phase + "-" + ++observation
  await writeFile(join(record, name + ".json"), JSON.stringify(processes, null, 2))
  if (process.env.ZAOVRA_FIRST_LAUNCH_TRACK_OWNERSHIP !== "1") return
  const deadline = Date.now() + 5000
  while (
    !(await stat(join(record, name + "-ack.json")).then(
      () => true,
      () => false,
    ))
  ) {
    assert(Date.now() < deadline, "ownership acknowledgement")
    await new Promise((done) => setTimeout(done, 25))
  }
}
async function launch() {
  phase += 1
  desktop = await _electron.launch({
    executablePath: executable,
    args: ["--user-data-dir=" + profile, "--lang=" + (locale === "zh" ? "zh-CN" : "en-US")],
    env,
    timeout: 90000,
  })
  const child = desktop.process()
  exited = new Promise((done) => child.once("exit", (code, signal) => done({ code, signal })))
  await writeFile(join(record, "electron-start-" + phase + ".json"), JSON.stringify({ pid: child.pid }))
  const runtime = await desktop.evaluate(({ app }) => ({
    packaged: app.isPackaged,
    version: app.getVersion(),
    locale: app.getLocale(),
    userData: app.getPath("userData"),
    documents: app.getPath("documents"),
    home: app.getPath("home"),
  }))
  summary.runtimes.push(runtime)
  assert.equal(runtime.packaged, true)
  for (const dir of [runtime.userData, runtime.documents, runtime.home])
    assert(resolve(dir).startsWith(record + "/") || resolve(dir).startsWith(record + "\\"), "isolated runtime paths")
  const page = await desktop.firstWindow({ timeout: 90000 })
  page.setDefaultTimeout(30000)
  page.on("pageerror", (error) => summary.pageErrors.push(error.stack ?? error.message))
  page.on("request", (request) => {
    if (/chat\/completions|\/responses$|\/messages$/.test(new URL(request.url()).pathname)) summary.modelRequests += 1
  })
  await page
    .locator('[data-component="prompt-input"][contenteditable="true"]')
    .waitFor({ state: "visible", timeout: 90000 })
  await page.locator('[data-component="desktop-sidebar-v2"]').waitFor({ state: "visible" })
  await ownership()
  return page
}
async function close() {
  if (!desktop) return
  await ownership()
  await desktop.close()
  const result = await exited
  summary.exits.push(result)
  desktop = undefined
  assert.equal(result.code, 0)
  assert.equal(result.signal, null)
}
async function capture(name) {
  const png = await desktop.evaluate(async ({ BrowserWindow }) =>
    (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString("base64"),
  )
  await writeFile(join(record, name), Buffer.from(png, "base64"))
  summary.screenshots.push(name)
}
try {
  let page = await launch()
  assert((await stat(directory)).isDirectory(), "locale default or legacy directory exists")
  let project = page.locator('[data-component="desktop-sidebar-v2"] [data-slot="sidebar-project"]').first()
  let heading = project.locator('[data-slot="project-heading"]')
  const initial = scenario.startsWith("legacy") ? (locale === "zh" ? "默认项目" : "Default project") : folder
  await page.getByText(initial, { exact: true }).first().waitFor({ state: "visible" })
  const chip = page.locator('[data-component="permission-chip"]')
  await chip.click()
  const permission = page.locator("[data-permission-menu]")
  await permission.waitFor({ state: "visible" })
  await permission.evaluate(async (el) =>
    Promise.all(el.getAnimations({ subtree: true }).map((animation) => animation.finished)),
  )
  summary.permissionRows = await permission
    .locator('[role="menuitem"]')
    .evaluateAll((items) =>
      items.map((el) => ({
        box: el.getBoundingClientRect().toJSON(),
        text: el.textContent,
        content: el.querySelector('[data-slot="menu-v2-item-content"]').getBoundingClientRect().toJSON(),
        parts: [...el.querySelectorAll('[data-slot="menu-v2-item-content"] > div > span')].map((span) =>
          span.getBoundingClientRect().toJSON(),
        ),
      })),
    )
  assert.equal(summary.permissionRows.length, 3)
  for (const [index, row] of summary.permissionRows.entries()) {
    assert.equal(row.parts.length, 2)
    assert(row.parts[0].bottom <= row.parts[1].top, "title and description do not overlap")
    assert(row.box.top <= row.content.top && row.content.bottom <= row.box.bottom, "description fits its row")
    if (index > 0) assert(summary.permissionRows[index - 1].box.bottom <= row.box.top, "permission rows do not overlap")
  }
  await capture("permission-menu-" + locale + ".png")
  await permission.locator('[role="menuitem"][data-mode="full"]').click()
  await permission.waitFor({ state: "hidden" })
  assert.equal(await chip.getAttribute("data-mode"), "full")
  await page.mouse.move(900, 100)
  assert.equal(
    await page.locator('[data-slot="full-access-warning"]').count(),
    0,
    "no persistent full-access explanation",
  )
  await capture("permission-selected-" + locale + ".png")
  await heading.click({ button: "right" })
  const menu = page.getByRole("menu")
  await menu.waitFor({ state: "visible" })
  summary.projectMenu = await menu.getByRole("menuitem").allTextContents()
  assert.equal(summary.projectMenu.length, 3, "only rename/reveal/remove project actions")
  assert(!summary.projectMenu.some((text) => /编辑项目|Edit project/.test(text)))
  await menu.getByRole("menuitem", { name: locale === "zh" ? "重命名" : "Rename", exact: true }).click()
  const name = locale === "zh" ? (scenario.startsWith("legacy") ? "旧目录资料" : "研究资料") : "Research project"
  const editor = project.locator('[data-action="project-rename"]')
  await editor.fill(name)
  await editor.press("Enter")
  await page.getByText(name, { exact: true }).first().waitFor({ state: "visible" })
  summary.renamed = name
  await close()
  page = await launch()
  project = page.locator('[data-component="desktop-sidebar-v2"] [data-slot="sidebar-project"]').first()
  heading = project.locator('[data-slot="project-heading"]')
  await page.getByText(name, { exact: true }).first().waitFor({ state: "visible" })
  summary.renamePersisted = true
  assert((await stat(directory)).isDirectory(), "rename keeps physical directory")
  if (scenario.startsWith("legacy"))
    assert.equal(await readFile(join(directory, "keep.txt"), "utf8"), "existing user work")
  await capture("project-renamed-restart-" + locale + ".png")
  assert.equal(await page.getByRole("dialog").count(), 0)
  assert.equal(summary.modelRequests, 0)
} catch (error) {
  summary.error = { name: error.name, message: error.message }
  throw error
} finally {
  await close()
  summary.stopped = true
  await writeFile(join(record, "result.json"), JSON.stringify(summary, null, 2) + "\n")
}
assert.equal(summary.pageErrors.length, 0)
console.log(JSON.stringify(summary))
