import assert from "node:assert/strict"
import { mkdir, writeFile, stat } from "node:fs/promises"
import { createServer } from "node:http"
import { isAbsolute, join, resolve } from "node:path"
import { _electron } from "playwright-core"

// Only an unpacked Dev artifact and a new isolated profile; never installed user data.
const executable = resolve(process.argv[2] ?? "")
const record = resolve(process.argv[3] ?? "")
const locale = process.argv[4] === "en" ? "en" : "zh"
const development = process.argv[5] === "--development"
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
let phase = 1
async function ownership() {
  const processes = await desktop.evaluate(({ app }) =>
    app.getAppMetrics().map((item) => ({ pid: item.pid, type: item.type })),
  )
  await writeFile(join(record, "processes-" + phase + ".json"), JSON.stringify(processes, null, 2))
  if (process.env.ZAOVRA_FIRST_LAUNCH_TRACK_OWNERSHIP !== "1") return
  const deadline = Date.now() + 5_000
  while (
    !(await stat(join(record, "processes-" + phase + "-ack.json")).then(
      () => true,
      () => false,
    ))
  ) {
    assert(Date.now() < deadline, "ownership recorder acknowledgement")
    await new Promise((done) => setTimeout(done, 25))
  }
}
try {
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
  await writeFile(join(record, "electron-start-1.json"), JSON.stringify({ pid: child.pid }))
  exited = new Promise((done) => child.once("exit", (code, signal) => done({ code, signal })))
  const runtime = await desktop.evaluate(({ app }) => ({
    packaged: app.isPackaged,
    version: app.getVersion(),
    userData: app.getPath("userData"),
    documents: app.getPath("documents"),
    home: app.getPath("home"),
  }))
  Object.assign(summary, runtime)
  assert.equal(runtime.packaged, !development)
  for (const dir of [runtime.userData, runtime.documents, runtime.home])
    assert(resolve(dir).startsWith(record + "/") || resolve(dir).startsWith(record + "\\"), "isolated runtime paths")
  let page = await desktop.firstWindow({ timeout: 90_000 })
  const observe = (current) => {
    current.on("pageerror", (error) => summary.pageErrors.push(error.stack ?? error.message))
    current.on("response", (response) => {
      const path = new URL(response.url()).pathname
      const method = response.request().method()
      if (response.status() >= 400) summary.failedResponses.push({ path, status: response.status() })
      if (/session/.test(path) && ["PATCH", "DELETE"].includes(method))
        summary.sessionMutations.push({ path, method, status: response.status() })
    })
  }
  observe(page)
  page.setDefaultTimeout(30_000)
  let input = page.locator('[data-component="prompt-input"][contenteditable="true"]')
  await input.waitFor({ state: "visible", timeout: 90_000 })
  let sidebar = page.locator('[data-component="desktop-sidebar-v2"]')
  await sidebar.waitFor({ state: "visible" })
  const heading = page.locator('[data-slot="new-session-heading"] h1')
  await heading.waitFor({ state: "visible" })
  const actualLocale = await page.locator("html").getAttribute("lang")
  assert.equal(actualLocale, locale, "actual interface language")
  assert.match(
    await heading.innerText(),
    locale === "zh" ? /早上好|中午好|下午好|晚上好/ : /Good morning|Good afternoon|Good evening|Good day/,
  )
  let project = sidebar.locator('[data-slot="sidebar-project"]').first()
  let projectHeading = project.locator('[data-slot="project-heading"]')
  const defaultLabel = locale === "zh" ? "默认项目" : "Default project"
  assert.equal((await projectHeading.innerText()).trim(), defaultLabel)
  assert.match(await page.locator('[data-slot="new-session-folder"]').innerText(), new RegExp(defaultLabel))
  assert(!/Default Project/.test(await page.locator("body").innerText()), "old default name is not displayed")
  assert((await stat(join(runtime.documents, "Default Project"))).isDirectory(), "internal directory is preserved")
  summary.assertions.homeGreeting = true
  summary.assertions.localizedFolder = true
  await page.screenshot({ path: join(record, "home-" + locale + ".png") })
  if (locale === "en") {
    await writeFile(join(record, "visible-ui.txt"), await page.locator("body").innerText())
  } else {
    // Capture genuinely empty first launch before adding any provider configuration.
    await ownership()
    await desktop.close()
    summary.firstLaunchExit = await exited
    assert.equal(summary.firstLaunchExit.code, 0)
    assert.equal(summary.firstLaunchExit.signal, null)
    await mkdir(config, { recursive: true })
    await writeFile(
      join(config, "zaovra.json"),
      JSON.stringify(
        {
          model: "fixture697/fixture",
          snapshot: false,
          enabled_providers: ["fixture697"],
          provider: {
            fixture697: {
              name: "Local fixture",
              env: [],
              npm: "@ai-sdk/openai-compatible",
              options: {
                baseURL: "http://127.0.0.1:" + fixture.address().port + "/v1",
                apiKey: "fixture-not-a-secret",
              },
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
        },
        null,
        2,
      ),
    )
    phase = 2
    desktop = await _electron.launch({
      executablePath: executable,
      args: [...(development ? [resolve(".")] : []), "--user-data-dir=" + profile, "--lang=zh-CN"],
      env,
      timeout: 90_000,
    })
    const second = desktop.process()
    exited = new Promise((done) => second.once("exit", (code, signal) => done({ code, signal })))
    await writeFile(join(record, "electron-start-2.json"), JSON.stringify({ pid: second.pid }))
    page = await desktop.firstWindow({ timeout: 90_000 })
    observe(page)
    page.setDefaultTimeout(30_000)
    input = page.locator('[data-component="prompt-input"][contenteditable="true"]')
    await input.waitFor({ state: "visible", timeout: 90_000 })
    sidebar = page.locator('[data-component="desktop-sidebar-v2"]')
    project = sidebar.locator('[data-slot="sidebar-project"]').first()
    projectHeading = project.locator('[data-slot="project-heading"]')
    const firstPrompt = "整理侧栏体验与项目命名"
    await input.fill(firstPrompt)
    await input.press("Enter")
    const session = sidebar.locator('[data-slot="titlebar-tab-item"]').filter({ hasText: firstPrompt })
    await session.waitFor({ state: "visible" })
    await page.getByText("Fixed local response.", { exact: true }).waitFor({ state: "visible" })
    summary.assertions.firstPromptLiveTitle = true
    await page.screenshot({ path: join(record, "auto-title.png") })
    await session.click({ button: "right" })
    const menu = page.getByRole("menu")
    await menu.waitFor({ state: "visible" })
    const menuLabels = await menu.getByRole("menuitem").allTextContents()
    assert(menuLabels.some((text) => text.trim() === "重命名"))
    assert(menuLabels.some((text) => /归档/.test(text)))
    assert(menuLabels.some((text) => /删除/.test(text)))
    assert(!menuLabels.some((text) => /置顶|Pin|Copy Link|Select All/.test(text)))
    await page.screenshot({ path: join(record, "session-context-menu.png") })
    await menu.getByRole("menuitem", { name: "重命名", exact: true }).click()
    const edit = sidebar.locator('[data-slot="tab-title"][contenteditable="true"]')
    await edit.waitFor({ state: "visible" })
    await edit.fill("取消后不保存")
    await edit.press("Escape")
    assert.equal((await session.locator('[data-slot="tab-title"]').innerText()).trim(), firstPrompt)
    await session.hover()
    await session.locator('[data-action="session-menu"]').click()
    assert.deepEqual(
      await menu.getByRole("menuitem").allTextContents(),
      menuLabels,
      "ellipsis and right click have the same actions",
    )
    await menu.getByRole("menuitem", { name: "重命名", exact: true }).click()
    await edit.fill("侧栏体验验收")
    await page.screenshot({ path: join(record, "session-inline-rename.png") })
    await edit.press("Enter")
    const renamed = sidebar.locator('[data-slot="titlebar-tab-item"]').filter({ hasText: "侧栏体验验收" })
    await renamed.waitFor({ state: "visible" })
    await input.fill("第二条消息保持手动标题")
    await input.press("Enter")
    await page.getByText("Fixed local response.", { exact: true }).nth(1).waitFor({ state: "visible" })
    assert.equal((await renamed.locator('[data-slot="tab-title"]').innerText()).trim(), "侧栏体验验收")
    summary.assertions.sessionRenameEnterAndEscape = true
    summary.assertions.manualTitlePreserved = true
    await projectHeading.click({ button: "right" })
    await menu.waitFor({ state: "visible" })
    const projectLabels = await menu.getByRole("menuitem").allTextContents()
    assert(projectLabels.some((text) => /资源管理器/.test(text)))
    assert(projectLabels.some((text) => /从列表移除/.test(text)))
    await page.screenshot({ path: join(record, "project-context-menu.png") })
    await menu.getByRole("menuitem", { name: "重命名", exact: true }).click()
    const projectEdit = sidebar.locator('[data-action="project-rename"]')
    await projectEdit.fill("取消项目名")
    await projectEdit.press("Escape")
    assert.equal((await projectHeading.innerText()).trim(), defaultLabel)
    await projectHeading.click({ button: "right" })
    await menu.getByRole("menuitem", { name: "重命名", exact: true }).click()
    await projectEdit.fill("界面体验项目")
    await page.screenshot({ path: join(record, "project-inline-rename.png") })
    await projectEdit.press("Enter")
    await page.getByRole("button", { name: "界面体验项目", exact: true }).waitFor({ state: "visible" })
    summary.assertions.projectRenameEnterAndEscape = true
    // Delete is a separate confirmed action, and cancelling leaves the session intact.
    await renamed.click({ button: "right" })
    await menu.getByRole("menuitem", { name: /删除/ }).click()
    const dialog = page.getByRole("dialog")
    await dialog.waitFor({ state: "visible" })
    await page.screenshot({ path: join(record, "session-delete-confirmation.png") })
    await dialog.getByRole("button", { name: "取消", exact: true }).click()
    await renamed.waitFor({ state: "visible" })
    summary.assertions.deleteConfirmationCancel = true
    await renamed.click({ button: "right" })
    await menu.getByRole("menuitem", { name: /归档/ }).click()
    await renamed.waitFor({ state: "hidden" })
    summary.assertions.archive = true
    const newButton = sidebar.getByRole("button", { name: /新对话|新会话/ }).first()
    await newButton.click()
    await input.fill("仅用于确认删除的会话")
    await input.press("Enter")
    const disposable = sidebar.locator('[data-slot="titlebar-tab-item"]').filter({ hasText: "仅用于确认删除的会话" })
    await disposable.waitFor({ state: "visible" })
    await page.getByText("Fixed local response.", { exact: true }).waitFor({ state: "visible" })
    await disposable.click({ button: "right" })
    await menu.getByRole("menuitem", { name: /删除/ }).click()
    await dialog.getByRole("button", { name: /删除/ }).click()
    await disposable.waitFor({ state: "hidden" })
    summary.assertions.confirmedDelete = true
    const renamedProject = sidebar.getByRole("button", { name: "界面体验项目", exact: true })
    await renamedProject.click({ button: "right" })
    await menu.getByRole("menuitem", { name: /从列表移除/ }).click()
    await renamedProject.waitFor({ state: "hidden" })
    assert((await stat(join(runtime.documents, "Default Project"))).isDirectory())
    summary.assertions.removeProjectKeepsDirectory = true
    assert(
      requests.length >= 3 && requests.every((item) => item.method === "POST" && item.path === "/v1/chat/completions"),
    )
  }
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
      await ownership()
    }
  } finally {
    if (desktop) {
      await desktop.close()
      summary.exit = await exited
      summary.stopped = true
    }
    await new Promise((done) => fixture.close(done))
    await writeFile(join(record, "result.json"), JSON.stringify(summary, null, 2) + "\n")
  }
}
assert.equal(summary.pageErrors.length, 0, "no renderer errors during the complete interaction")
assert.equal(summary.exit.signal, null)
assert.equal(summary.exit.code, 0)
console.log(JSON.stringify(summary))
