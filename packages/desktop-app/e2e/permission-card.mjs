import assert from "node:assert/strict"
import { createServer } from "node:http"
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
const rejectOnly = scenario === "reject-zh"
const requests = []
const command =
  "echo " + Array.from({ length: 90 }, (_, i) => "permission-layout-path-" + i + "/subdirectory/argument").join(" ")
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
      id: "fixture701",
      object: "chat.completion.chunk",
      created: 1,
      model: "fixture",
      choices: [{ index: 0, delta, finish_reason }],
    })
  const content =
    requests.length === 1
      ? {
          role: "assistant",
          content:
            Array.from({ length: 60 }, (_, i) => "固定本地说明 " + i + "：检查卡片展开时仍能滚动主对话。").join(
              "\n\n",
            ) + "\n\n固定本地说明末尾701",
        }
      : requests.length === 2
        ? {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "call_permission701",
                type: "function",
                function: {
                  name: "bash",
                  arguments: JSON.stringify({ command, description: "本地权限卡片布局验证", timeout: 1000 }),
                },
              },
            ],
          }
        : { role: "assistant", content: "本地权限卡片已拒绝，未执行命令。" }
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
  response.end(
    "data: " +
      chunk(content) +
      "\n\ndata: " +
      chunk({}, requests.length === 2 ? "tool_calls" : "stop") +
      "\n\ndata: [DONE]\n\n",
  )
})
await new Promise((done) => fixture.listen(0, "127.0.0.1", done))
summary.fixtureRequests = requests
summary.commandExecution = "selected reject; actual isolated transcript checked after exit"
summary.measurements = []
async function resize(width, height) {
  await desktop.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setBounds(size), {
    width,
    height,
  })
}
async function measure(page, name) {
  const metrics = await page.evaluate(() => {
    const card = document.querySelector('[data-component="dock-prompt"][data-kind="permission"]')
    const content = card.querySelector('[data-slot="permission-content"]')
    const timeline = document.querySelector("[data-timeline-virtual-content]").closest("[data-scrollable]")
    return {
      viewport: { width: innerWidth, height: innerHeight },
      card: card.getBoundingClientRect().toJSON(),
      content: {
        box: content.getBoundingClientRect().toJSON(),
        scrollHeight: content.scrollHeight,
        clientHeight: content.clientHeight,
      },
      expanded: card.querySelector('[data-slot="permission-details"]').open,
      timeline: {
        box: timeline.getBoundingClientRect().toJSON(),
        scrollHeight: timeline.scrollHeight,
        clientHeight: timeline.clientHeight,
      },
      buttons: [...card.querySelectorAll('[data-slot="permission-footer-actions"] button')].map((button) => {
        const box = button.getBoundingClientRect()
        return {
          text: button.textContent,
          box: box.toJSON(),
          reachable: button.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)),
        }
      }),
    }
  })
  assert.equal(metrics.buttons.length, 3)
  for (const button of metrics.buttons) {
    assert(button.box.top >= 0 && button.box.bottom <= metrics.viewport.height, "button within viewport")
    assert(button.reachable, "button unobstructed")
  }
  assert(metrics.card.height <= Math.min(420, metrics.viewport.height * 0.45) + 1, "card reserves chat height")
  assert(metrics.timeline.clientHeight > 100, "chat retains a scroll viewport")
  assert(metrics.timeline.scrollHeight > metrics.timeline.clientHeight, "actual long conversation can scroll")
  summary.measurements.push({ name, ...metrics })
  await capture(name + ".png")
}
try {
  let page = await launch()
  await close()
  const config = join(profile, "desktop", "backend", "config", "zaovra")
  await mkdir(config, { recursive: true })
  await writeFile(
    join(config, "zaovra.json"),
    JSON.stringify(
      {
        model: "fixture701/fixture",
        permission: { bash: { "*": "ask" } },
        snapshot: false,
        enabled_providers: ["fixture701"],
        provider: {
          fixture701: {
            name: "Local permission fixture",
            env: [],
            npm: "@ai-sdk/openai-compatible",
            options: { baseURL: "http://127.0.0.1:" + fixture.address().port + "/v1", apiKey: "fixture-not-a-secret" },
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
  page = await launch()
  await resize(1900, 1080)
  let input = page.locator('[data-component="prompt-input"][contenteditable="true"]')
  await input.fill("本地卡片布局验收：先展示长内容")
  await input.press("Enter")
  await page.getByText("固定本地说明末尾701", { exact: true }).waitFor({ state: "visible", timeout: 90000 })
  const review = page.locator("#review-panel")
  if (!(await review.isVisible())) await page.keyboard.press("Control+Shift+R")
  await review.waitFor({ state: "visible" })
  assert.equal(await review.getAttribute("aria-hidden"), "false")
  const chip = page.locator('[data-component="permission-chip"]')
  await chip.click()
  await page.locator('[data-permission-menu] [data-mode="ask"]').click()
  input = page.locator('[data-component="prompt-input"][contenteditable="true"]')
  await input.fill("请求本地权限卡片；拒绝后结束")
  await input.press("Enter")
  const card = page.locator('[data-component="dock-prompt"][data-kind="permission"]')
  await card.waitFor({ state: "visible", timeout: 90000 })
  const details = card.locator('[data-slot="permission-details"]')
  assert.equal(await details.getAttribute("open"), null, "details collapsed by default")
  assert.equal(await card.locator('[data-slot="permission-command"]').innerText(), command)
  if (!rejectOnly) {
    await measure(page, "card-collapsed-1900")
    await details.locator(":scope > summary").click()
    await measure(page, "card-expanded-1900")
    const scroll = page.locator("[data-scrollable]").filter({ has: page.locator("[data-timeline-virtual-content]") })
    await scroll.evaluate((el) => {
      el.scrollTop = el.scrollHeight
    })
    const before = await scroll.evaluate((el) => el.scrollTop)
    await scroll.hover({ position: { x: 100, y: 100 } })
    await page.mouse.wheel(0, -600)
    await page.waitForFunction((previous) => {
      const el = document.querySelector("[data-timeline-virtual-content]").closest("[data-scrollable]")
      return el.scrollTop < previous
    }, before)
    summary.chatWheelScroll = true
    await resize(900, 640)
    await review.waitFor({ state: "hidden" })
    await measure(page, "card-expanded-narrow-900")
    await card.locator('[data-slot="permission-content"]').evaluate((el) => {
      el.scrollTop = el.scrollHeight
    })
    await measure(page, "card-details-scrolled-900")
  }
  if (rejectOnly) {
    await details.locator(":scope > summary").click()
    await resize(900, 640)
    await review.waitFor({ state: "hidden" })
    const content = card.locator('[data-slot="permission-content"]')
    await content.hover()
    await page.mouse.wheel(0, 20000)
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-slot="permission-content"]')
      return el.scrollTop > 0 && el.scrollTop + el.clientHeight >= el.scrollHeight - 2
    })
    summary.detailsActualScroll = await content.evaluate((el) => ({
      top: el.scrollTop,
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
    }))
    await measure(page, "card-details-bottom-900")
  }
  const decision = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      /permission/.test(new URL(response.url()).pathname) &&
      /\"reply\"\s*:\s*\"reject\"/.test(response.request().postData() ?? ""),
  )
  await card.locator('[data-slot="permission-footer-actions"] button').first().click()
  await card.waitFor({ state: "hidden" })
  const denied = await decision
  assert.equal(denied.status(), 204)
  summary.permissionDecision = { status: denied.status(), path: new URL(denied.url()).pathname, reply: "reject" }
  summary.permissionCardHidden = true
  if (rejectOnly) await capture("card-reject-ack.png")
  assert.equal(requests.length, 2, "two local fixed responses during card verification")
  assert.equal(summary.pageErrors.length, 0)
} catch (error) {
  summary.error = { name: error.name, message: error.message }
  if (desktop) {
    await capture("failure.png")
    await writeFile(join(record, "failure-ui.txt"), await (await desktop.firstWindow()).locator("body").innerText())
  }
  throw error
} finally {
  await close()
  await new Promise((done) => fixture.close(done))
  summary.stopped = true
  await writeFile(join(record, "result.json"), JSON.stringify(summary, null, 2) + "\n")
}
console.log(JSON.stringify(summary))
