import assert from "node:assert/strict"
import { mkdir, writeFile, readFile, stat } from "node:fs/promises"
import { createServer } from "node:http"
import { isAbsolute, join, resolve } from "node:path"
import { _electron } from "playwright-core"

// Ordinary development build with a new isolated profile; never installed user data.
const executable = resolve(process.argv[2] ?? "")
const record = resolve(process.argv[3] ?? "")
const locale = process.argv[4] === "en" ? "en" : "zh"
const development = process.argv[5] === "--development"
// Scripted DOM regression is separate from manual system-IME acceptance.
const systemIme = !process.argv.includes("--scripted")
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

  await desktop.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    win.setSize(1900, 1080)
    win.setTitle("Zaovra IME707 isolated")
  })
  await ownership()
  const firstPrompt = "输入法验收"
  await input.fill(firstPrompt)
  await input.press("Enter")
  await page.getByText("Fixed local response.", { exact: true }).waitFor({ state: "visible" })
  const session = sidebar.locator('[data-slot="titlebar-tab-item"]').filter({ hasText: firstPrompt })
  await session.waitFor({ state: "visible" })
  const href = await session.locator('[data-slot="tab-link"]').getAttribute("href")
  const roots = page
    .locator('[data-slot="titlebar-tab-item"]')
    .filter({ has: page.locator("a[href=" + JSON.stringify(href) + "]") })
  const locations = await roots.evaluateAll((nodes) =>
    nodes.map((node, index) => ({ index, sidebar: !!node.closest('[data-component="desktop-sidebar-v2"]') })),
  )
  assert.equal(locations.length, 1, "current desktop layout exposes one sidebar session tab")
  summary.titlebarCoverage = "shared TabNavItem implementation; minimal desktop titlebar does not render a second tab"
  const surfaces = [
    { name: "project", root: sidebar.locator('[data-slot="sidebar-project"]').first() },
    ...locations.map((item) => ({
      name: item.sidebar ? "sidebar-session" : "titlebar-session",
      root: roots.nth(item.index),
    })),
  ]
  async function open(surface) {
    if (surface.name === "project") {
      await surface.root.locator('[data-slot="project-heading"]').click({ button: "right" })
      await page.getByRole("menu").getByRole("menuitem", { name: "重命名", exact: true }).click()
      const editor = surface.root.locator('[data-action="project-rename"]')
      await editor.waitFor({ state: "visible" })
      return editor
    }
    const editor = surface.root.locator('[data-slot="tab-title"]')
    await editor.dblclick()
    await page.waitForFunction((element) => element.isContentEditable, await editor.elementHandle())
    return editor
  }
  async function text(editor, value) {
    await editor.fill(value)
  }
  async function editing(surface) {
    return surface.name === "project"
      ? await surface.root.locator('[data-action="project-rename"]').isVisible()
      : (await surface.root.getAttribute("data-editing")) === "true"
  }
  async function waitClosed(surface) {
    if (surface.name === "project")
      await surface.root.locator('[data-action="project-rename"]').waitFor({ state: "hidden" })
    else
      await page.waitForFunction((element) => element.dataset.editing === "false", await surface.root.elementHandle())
  }
  summary.synthetic = []
  const titleText = (surface) =>
    surface.root
      .locator(surface.name === "project" ? '[data-slot="project-heading"]' : '[data-slot="tab-title"]')
      .innerText()
  for (const surface of surfaces) {
    const editor = await open(surface)
    await text(editor, "组合输入验证")
    const probes = await editor.evaluate((node) => {
      const results = []
      for (const key of ["Enter", "Escape"]) {
        const event = new KeyboardEvent("keydown", {
          key,
          isComposing: true,
          keyCode: 229,
          bubbles: true,
          cancelable: true,
        })
        node.dispatchEvent(event)
        results.push({ key, defaultPrevented: event.defaultPrevented })
      }
      node.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }))
      for (const key of ["Enter", "Escape", "ArrowDown", "Tab"]) {
        const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })
        node.dispatchEvent(event)
        results.push({ key, tracking: true, defaultPrevented: event.defaultPrevented })
      }
      node.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "组合输入验证" }))
      return results
    })
    assert(probes.every((item) => !item.defaultPrevented))
    assert(await editing(surface), "composition keys preserve editing")
    await editor.press("Enter")
    await waitClosed(surface)
    assert.equal((await titleText(surface)).trim(), "组合输入验证")
    const cancel = await open(surface)
    await text(cancel, "不得保存的取消值")
    await cancel.press("Escape")
    await waitClosed(surface)
    assert.equal((await titleText(surface)).trim(), "组合输入验证", "Escape preserves the saved title")
    const tab = await open(surface)
    await text(tab, "Tab失焦验证")
    await tab.press("Tab")
    await waitClosed(surface)
    assert.equal((await titleText(surface)).trim(), "Tab失焦验证")
    const blur = await open(surface)
    await text(blur, "指针失焦验证")
    await input.click()
    await waitClosed(surface)
    assert.equal((await titleText(surface)).trim(), "指针失焦验证")
    await page.screenshot({ path: join(record, surface.name + "-synthetic.png") })
    summary.synthetic.push({ surface: surface.name, probes, enter: true, escape: true, tab: true, blur: true })
  }
  await page.evaluate(() => {
    window.ime707Events = []
    for (const type of ["compositionstart", "compositionupdate", "compositionend", "keydown", "blur", "input"])
      document.addEventListener(
        type,
        (event) => {
          const target = event.target
          if (
            !(target instanceof HTMLElement) ||
            !target.matches('[data-action="project-rename"],[data-slot="tab-title"]')
          )
            return
          window.ime707Events.push({
            type,
            trusted: event.isTrusted,
            key: event.key ?? null,
            keyCode: event.keyCode ?? null,
            isComposing: event.isComposing ?? null,
            data: event.data ?? null,
            text: target instanceof HTMLInputElement ? target.value : target.textContent,
          })
        },
        true,
      )
  })
  summary.native = []
  summary.systemImeRequested = systemIme
  for (const [index, surface] of (systemIme ? surfaces : []).entries()) {
    await open(surface)
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setTitle("Zaovra IME707 isolated"))
    await writeFile(join(record, "native-ready-" + index + ".json"), JSON.stringify({ surface: surface.name, index }))
    const deadline = Date.now() + 20 * 60 * 1000
    while (
      !(await stat(join(record, "native-done-" + index + ".json")).then(
        () => true,
        () => false,
      ))
    ) {
      assert(Date.now() < deadline, "native IME interaction deadline")
      await new Promise((done) => setTimeout(done, 100))
    }
    const completion = JSON.parse(await readFile(join(record, "native-done-" + index + ".json"), "utf8"))
    assert(!completion.aborted, "manual system IME acceptance was blocked; see native-tool-blocked record")
    await waitClosed(surface)
    const events = await page.evaluate(() => window.ime707Events.splice(0))
    await writeFile(join(record, "native-events-" + index + ".json"), JSON.stringify(events, null, 2))
    assert(
      events.some((event) => event.type === "compositionstart" && event.trusted),
      "real trusted system compositionstart required",
    )
    assert(
      events.some(
        (event) =>
          event.type === "keydown" &&
          event.trusted &&
          event.key === "Enter" &&
          (event.isComposing || event.keyCode === 229),
      ),
      "real IME Enter required",
    )
    summary.native.push({ surface: surface.name, trustedComposition: true })
    await page.screenshot({ path: join(record, surface.name + "-native-final.png") })
  }
  assert.equal(requests.length, 1, "one local fixed provider request only")
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
