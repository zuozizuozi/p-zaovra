import assert from "node:assert/strict"
import { mkdir, writeFile, stat } from "node:fs/promises"
import { createServer } from "node:http"
import { isAbsolute, join, resolve } from "node:path"
import { _electron } from "playwright-core"

// Only an unpacked Dev artifact and a new isolated profile; never installed user data.
const executable = resolve(process.argv[2] ?? "")
const record = resolve(process.argv[3] ?? "")
const locale = "zh"
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
      id: "fixture698",
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
async function capture(name) {
  const png = await desktop.evaluate(async ({ BrowserWindow }) =>
    (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString("base64"),
  )
  await writeFile(join(record, name), Buffer.from(png, "base64"))
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
        model: "fixture698/fixture",
        snapshot: false,
        enabled_providers: ["fixture698"],
        provider: {
          fixture698: {
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
  const project = sidebar.locator('[data-slot="sidebar-project"]').first()
  const projectHeading = project.locator('[data-slot="project-heading"]')
  const firstPrompt = "侧栏体验验收：侧边文字颜色"
  await input.fill(firstPrompt)
  await input.press("Enter")
  const session = sidebar.locator('[data-slot="titlebar-tab-item"]').filter({ hasText: firstPrompt })
  await session.waitFor({ state: "visible" })
  await page.getByText("Fixed local response.", { exact: true }).waitFor({ state: "visible" })
  summary.lcdTextDisabled = await desktop.evaluate(({ app }) => app.commandLine.hasSwitch("disable-lcd-text"))
  summary.textStyles = await page.evaluate(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT),
      nodes = []
    while (walker.nextNode()) {
      const text = walker.currentNode
      if (!text.textContent?.includes("侧")) continue
      const el = text.parentElement
      if (!el || el.closest("script,style")) continue
      const style = getComputedStyle(el),
        offset = text.textContent.indexOf("侧"),
        range = document.createRange()
      range.setStart(text, offset)
      range.setEnd(text, offset + 1)
      nodes.push({
        text: text.textContent,
        html: el.outerHTML,
        color: style.color,
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        box: range.getBoundingClientRect().toJSON(),
      })
    }
    return nodes
  })
  await capture("title-zh.png")
  await projectHeading.click({ button: "right" })
  const menu = page.getByRole("menu")
  await menu.waitFor({ state: "visible" })
  await menu.evaluate(async (el) => {
    await Promise.all(el.getAnimations({ subtree: true }).map((animation) => animation.finished))
  })
  summary.menu = await menu.evaluate((el) => ({
    box: el.getBoundingClientRect().toJSON(),
    items: [...el.querySelectorAll('[role="menuitem"]')].map((x) => ({
      text: x.textContent,
      box: x.getBoundingClientRect().toJSON(),
      height: getComputedStyle(x).height,
    })),
    separators: el.querySelectorAll('[data-slot="menu-v2-separator"]').length,
  }))
  summary.sidebarBox = await sidebar.boundingBox()
  await capture("project-menu-zh.png")
  if (process.argv[4] === "verify") {
    assert(summary.lcdTextDisabled, "Windows grayscale text rendering enabled")
    assert(
      summary.menu.items.every((x) => x.box.height >= 28),
      "consistent menu row height",
    )
    assert(summary.menu.box.x >= summary.sidebarBox.x, "menu inside sidebar left edge")
    assert(
      summary.menu.box.right <= summary.sidebarBox.x + summary.sidebarBox.width + 1,
      "menu inside sidebar right edge",
    )
    assert(summary.menu.separators >= 1, "remove action separated")
    assert(
      summary.menu.items.every((x) => !x.text.includes("仅移出列表")),
      "no cramped two-line description",
    )
  }
  await ownership()
} catch (error) {
  summary.error = { name: error.name, message: error.message }
  throw error
} finally {
  try {
    if (desktop) await ownership()
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
assert.equal(summary.pageErrors.length, 0)
assert.equal(summary.exit.code, 0)
assert.equal(summary.exit.signal, null)
console.log(JSON.stringify(summary))
