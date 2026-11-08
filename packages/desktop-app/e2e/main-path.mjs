import assert from "node:assert/strict"
import { createServer } from "node:http"
import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile, stat } from "node:fs/promises"
import { join, resolve, relative, isAbsolute, basename } from "node:path"
import { pathToFileURL } from "node:url"
import { createRequire } from "node:module"
import { requireMainPath } from "./main-path-report.mjs"
const { _electron } = createRequire(import.meta.url)("playwright-core")

// All model traffic is handled by this loopback fixture. UI actions use real input.
export async function mainPath(options) {
  const executable = resolve(options.executable)
  const record = resolve(options.record)
  assert.equal(
    await stat(record).then(
      () => true,
      () => false,
    ),
    false,
    "fresh evidence/profile",
  )
  await mkdir(record, { recursive: true })
  const environment = options.env ?? process.env
  const env = Object.fromEntries(
    ["SystemRoot", "WINDIR", "COMSPEC", "PATH", "PATHEXT"].flatMap((key) =>
      environment[key] ? [[key, environment[key]]] : [],
    ),
  )
  for (const [key, folder] of Object.entries({
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
    env[key] = join(record, folder)
    await mkdir(env[key], { recursive: true })
  }
  env.ZAOVRA_TEST_ONBOARDING = "1"
  env.ZAOVRA_DISABLE_MODELS_FETCH = "true"
  const isolationRoot = resolve(options.isolationRoot ?? record)
  const profile = resolve(options.profile ?? join(record, "temp", "profile"))
  assert(
    !relative(isolationRoot, profile).startsWith("..") && !isAbsolute(relative(isolationRoot, profile)),
    "test profile stays inside isolation root",
  )
  if (options.profile) for (const key of ["TEMP", "TMP", "TMPDIR"]) env[key] = resolve(profile, "..")
  const project = join(profile, "documents", "Zaovra 项目")
  const steerMarker = "STEER716-" + basename(record)
  const steerMessage = steerMarker + "：下一步采用这条要求"
  const report = {
    schema: 1,
    source: options.source,
    executable,
    record,
    profile,
    executableSHA256: createHash("sha256")
      .update(await readFile(executable))
      .digest("hex"),
    scope: "A2.1-6",
    modelCalls: 0,
    paidModelCalls: 0,
    steps: [],
    assertions: [],
    screenshots: [],
    pageErrors: [],
    requests: [],
    closed: false,
  }
  const control = {
    stream: Promise.withResolvers(),
    steer: Promise.withResolvers(),
    held: Promise.withResolvers(),
    action: "",
    turn: 0,
    responses: new Set(),
  }
  const requests = []
  const provider = createServer(async (req, res) => {
    try {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const raw = Buffer.concat(chunks)
      report.requests.push({ method: req.method, path: req.url, bytes: raw.length })
      if (req.method === "GET" && /\/models$/.test(req.url)) {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(
          JSON.stringify({
            object: "list",
            data: [
              { id: "mp-main", object: "model", owned_by: "local" },
              { id: "mp-secondary", object: "model", owned_by: "local" },
            ],
          }),
        )
        return
      }
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
        res.writeHead(404).end()
        return
      }
      assert.equal(req.method, "POST")
      assert.equal(req.url, "/v1/chat/completions")
      assert.equal(req.headers.authorization, "Bearer main-path-synthetic")
      const body = JSON.parse(raw.toString("utf8"))
      requests.push(body)
      report.modelCalls++
      if (options.respond) {
        control.responses.add(res)
        res.once("close", () => control.responses.delete(res))
        await options.respond(body, res)
        return
      }
      const user = body.messages.filter((message) => message.role === "user").at(-1)
      const text = JSON.stringify(user?.content ?? "")
      const action = /MP[456]/.exec(text)?.[0] ?? control.action
      if (action !== control.action) {
        control.action = action
        control.turn = 0
      }
      control.turn++
      const tool =
        action === "MP5" && control.turn <= 2
          ? control.turn === 1
            ? {
                name: "apply_patch",
                arguments: JSON.stringify({
                  patchText: "*** Begin Patch\n*** Add File: main-path.txt\n+main-path-written\n*** End Patch",
                }),
              }
            : {
                name: "bash",
                arguments: JSON.stringify({
                  command:
                    "node -e \"const f=require('fs');if(f.readFileSync('main-path.txt','utf8').trimEnd()!=='main-path-written')process.exit(2);f.writeFileSync('command-ran.txt','allowed-once')\"",
                  description: "验证允许一次后执行本地命令",
                }),
              }
          : action === "MP6" && control.turn === 1
            ? { name: "read", arguments: JSON.stringify({ path: "main-path.txt" }) }
            : undefined
      const content =
        action === "MP4"
          ? "实时回复已到达"
          : action === "MP5"
            ? "文件与命令均已完成"
            : action === "MP6" && control.turn > 1
              ? (assert(JSON.stringify(body.messages).includes(steerMarker), "next turn receives admitted steer"),
                "已按插话" + steerMarker + "执行下一步")
              : action === "MP6"
                ? "第一步正在执行"
                : "本地服务连接有效"
      if (body.stream !== true) {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(
          JSON.stringify({
            id: "main-path-check",
            object: "chat.completion",
            model: "mp-returned",
            choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        )
        return
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
      control.responses.add(res)
      res.once("close", () => control.responses.delete(res))
      const send = (delta, finish_reason = null) =>
        res.write(
          "data: " +
            JSON.stringify({
              id: "main-path-" + requests.length,
              object: "chat.completion.chunk",
              created: 1,
              model: "mp-returned",
              choices: [{ index: 0, delta, finish_reason }],
            }) +
            "\n\n",
        )
      send({ role: "assistant", content: tool && action === "MP5" ? "" : content })
      if (tool)
        assert(
          body.tools?.some((item) => item.function?.name === tool.name),
          "fixture only calls offered tools",
        )
      if (tool)
        send({
          tool_calls: [{ index: 0, id: "call_mp_" + action + "_" + control.turn, type: "function", function: tool }],
        })
      if (action === "MP4") await control.stream.promise
      if (action === "MP6" && control.turn === 1) {
        control.held.resolve()
        await control.steer.promise
      }
      if (!res.destroyed) {
        send({}, tool ? "tool_calls" : "stop")
        res.end("data: [DONE]\n\n")
      }
    } catch (error) {
      report.providerError = String(error)
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: { message: "Local main-path fixture failed" } }))
    }
  })
  await new Promise((done) => provider.listen(options.providerPort ?? 0, "127.0.0.1", done))
  report.provider = "http://127.0.0.1:" + provider.address().port + "/v1"
  const desktop = await _electron
    .launch({
      executablePath: executable,
      cwd: record,
      args: [...(options.launchArgs ?? []), "--user-data-dir=" + profile, "--lang=zh-CN"],
      env,
      timeout: 90000,
    })
    .catch(async (error) => {
      await new Promise((done) => provider.close(done))
      throw error
    })
  const child = desktop.process()
  const exited = new Promise((done) => child.once("exit", (code, signal) => done({ code, signal })))
  report.launcherPID = child.pid
  try {
    report.runtime = await desktop.evaluate(({ app, BrowserWindow }) => ({
      packaged: app.isPackaged,
      version: app.getVersion(),
      userData: app.getPath("userData"),
      documents: app.getPath("documents"),
      home: app.getPath("home"),
      windows: BrowserWindow.getAllWindows().map((win) => ({
        bounds: win.getBounds(),
        content: win.getContentBounds(),
      })),
    }))
    assert.equal(report.runtime.packaged, options.packaged ?? true, "actual Electron distribution mode")
    for (const p of [report.runtime.userData, report.runtime.documents, report.runtime.home])
      assert(
        !relative(isolationRoot, p).startsWith("..") && !isAbsolute(relative(isolationRoot, p)),
        "isolated runtime paths",
      )
    const page = await desktop.firstWindow({ timeout: 90000 })
    report.startupProcesses = await desktop.evaluate(({ app }) =>
      app.getAppMetrics().map((item) => ({ pid: item.pid, type: item.type })),
    )
    report.pid = report.startupProcesses.find((item) => item.type === "Browser")?.pid
    page.setDefaultTimeout(30000)
    page.on("pageerror", (error) => report.pageErrors.push(error.message))
    const input = page.locator('[data-component="prompt-input"][contenteditable="true"]')
    async function capture(name) {
      const jpg = await desktop.evaluate(async ({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0]
        const [width, height] = win.getContentSize()
        return (await win.capturePage()).resize({ width, height, quality: "best" }).toJPEG(85).toString("base64")
      })
      await writeFile(join(record, name + ".jpg"), Buffer.from(jpg, "base64"))
      report.screenshots.push(name + ".jpg")
    }
    async function checkpoint(id, title, run) {
      const item = { id, title, status: "running" }
      report.steps.push(item)
      try {
        await run()
        item.status = "pass"
      } catch (error) {
        item.status = "fail"
        item.error = String(error)
        await capture("failure-" + id).catch(() => {})
        throw error
      } finally {
        await writeFile(join(record, "main-path.json"), JSON.stringify(report, null, 2) + "\n")
      }
    }
    async function fresh() {
      await checkpoint(1, "新profile主界面（安装阶段另验）", async () => {
        await input.waitFor({ state: "visible", timeout: 90000 })
        await page.locator('[data-component="desktop-sidebar-v2"]').waitFor({ state: "visible" })
        assert((await stat(project)).isDirectory())
        await page.getByText("Zaovra 项目", { exact: true }).first().waitFor({ state: "visible" })
        assert.equal(await page.getByRole("dialog").count(), 0, "fresh has no welcome/highlights popup")
        assert(!/Default Project|欢迎使用|会话预算/.test(await page.locator("body").innerText()))
        report.assertions.push("A1.1", "A1.2", "A1.12", "A1.18-fresh")
        await capture("01-fresh")
      })
      report.steps[0].installation = "unverified: unpacked artifact; not an installer launch"
      // A permission fixture, not a provider/credential or an upgrade-state injection.
      await mkdir(join(project, ".zaovra"), { recursive: true })
      await writeFile(
        join(project, ".zaovra", "zaovra.json"),
        JSON.stringify({ permission: { bash: { "*": "ask" } }, snapshot: false }) + "\n",
      )
    }
    async function connect() {
      await checkpoint(3, "界面添加OpenAI兼容服务并选一个模型", async () => {
        await page.keyboard.press("Control+,")
        await page.getByRole("tab", { name: "模型服务", exact: true }).click()
        await page
          .locator('[data-component="custom-provider-section"]')
          .getByRole("button", { name: "连接", exact: true })
          .click()
        await page.getByLabel("基础 URL", { exact: true }).fill(report.provider)
        await page.getByLabel("API 密钥", { exact: true }).fill("main-path-synthetic")
        await page.locator("details > summary").filter({ hasText: "高级设置" }).click()
        await page.getByLabel("兼容协议", { exact: true }).selectOption("openai")
        await page.getByRole("button", { name: "获取模型", exact: true }).click()
        await page.getByText("mp-main", { exact: true }).first().waitFor({ state: "visible" })
        await page.getByRole("button", { name: "保存配置", exact: true }).click()
        await page.getByRole("dialog").waitFor({ state: "hidden" })
        await page.getByRole("button", { name: "关闭", exact: true }).click()
        await input.waitFor({ state: "visible" })
        await page.locator('[data-action="prompt-model"]').click()
        const models = page.getByRole("menuitemradio")
        assert.equal(await models.count(), 2, "only this configured service's two models")
        assert.equal(await page.getByRole("checkbox").count(), 0, "single select")
        const main = models.filter({ hasText: "mp-main" })
        assert.equal(await main.getAttribute("aria-checked"), "true", "new service selects a concrete primary model")
        await main.click()
        assert(!/auto|自动/.test(await page.locator('[data-action="prompt-model"]').innerText()))
        report.assertions.push("A1.4", "A1.5", "A1.6")
        await capture("03-service-selected")
      })
    }
    async function reply() {
      await checkpoint(4, "流式回复无需切换会话即可见", async () => {
        await input.fill("MP4：只回复一句话")
        await input.press("Enter")
        await page.getByText("实时回复已到达", { exact: true }).waitFor({ state: "visible" })
        await page.getByRole("button", { name: /^(停止|Stop)$/ }).waitFor({ state: "visible" })
        await capture("04-streaming-before-finish")
        control.stream.resolve()
        await page.getByRole("button", { name: /^(停止|Stop)$/ }).waitFor({ state: "hidden" })
        assert.equal(requests.at(-1).model, "mp-main")
        await page.getByText(/Build · mp-returned/).waitFor({ state: "visible" })
        report.assertions.push("A1.8", "A1.9")
        await capture("04-complete")
      })
    }
    async function tools() {
      await checkpoint(5, "写文件和命令；允许一次真实执行", async () => {
        await page.locator('[data-component="permission-chip"]').click()
        await page.locator('[data-permission-menu] [data-mode="ask"]').click()
        await input.fill("MP5：写文件并执行一次本地验证命令")
        await input.press("Enter")
        const card = page.locator('[data-component="dock-prompt"][data-kind="permission"]')
        // The project fixture asks for bash. File mutation uses the ordinary project policy.
        for (let count = 0; count < 1; count++) {
          await card.waitFor({ state: "visible", timeout: 90000 })
          const button = card.getByRole("button", { name: "允许一次", exact: true })
          const box = await button.boundingBox()
          const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
          assert(box && box.y >= 0 && box.y + box.height <= viewport.height)
          await capture("05-permission-" + count)
          await button.click()
          await card.waitFor({ state: "hidden" })
        }
        await page.getByText("文件与命令均已完成", { exact: true }).waitFor({ state: "visible", timeout: 90000 })
        assert.equal((await readFile(join(project, "main-path.txt"), "utf8")).trimEnd(), "main-path-written")
        assert.equal(await readFile(join(project, "command-ran.txt"), "utf8"), "allowed-once")
        report.assertions.push("A1.13-visible")
        await capture("05-executed")
      })
    }
    async function steer() {
      await checkpoint(6, "运行中插话立即显示且下一步采用", async () => {
        await input.waitFor({ state: "visible", timeout: 90000 })
        await input.fill("MP6：执行两步任务")
        await input.press("Enter")
        const deadline = setTimeout(() => control.held.reject(new Error("provider turn did not start")), 30000)
        await control.held.promise.finally(() => clearTimeout(deadline))
        await page.getByRole("button", { name: /^(停止|Stop)$/ }).waitFor({ state: "visible" })
        assert.equal(
          await page.getByRole("checkbox", { name: "任务结束后再发", exact: true }).isChecked(),
          false,
          "Enter steers by default",
        )
        await input.fill(steerMessage)
        await input.press("Enter")
        const inserted = page
          .locator('[data-slot="session-turn-message-content"]')
          .filter({ has: page.getByText(steerMessage, { exact: true }) })
        assert.equal(await inserted.count(), 1, "one new steer message")
        await inserted
          .getByRole("status")
          .getByText("已插入，下一步生效", { exact: true })
          .waitFor({ state: "visible" })
        await page.getByText(steerMessage, { exact: true }).waitFor({ state: "visible" })
        await page.getByRole("button", { name: /^(停止|Stop)$/ }).waitFor({ state: "visible" })
        await capture("06-steer-admitted")
        control.steer.resolve()
        await page
          .getByText("已按插话" + steerMarker + "执行下一步", { exact: true })
          .waitFor({ state: "visible", timeout: 90000 })
        report.assertions.push("A1.10-steer")
        await capture("06-steer-applied")
      })
    }
    async function close() {
      if (report.closed) return
      control.stream.resolve()
      control.steer.resolve()
      for (const response of control.responses) response.destroy()
      report.processes = await desktop
        .evaluate(({ app }) => app.getAppMetrics().map((item) => ({ pid: item.pid, type: item.type })))
        .catch(() => [])
      await desktop.close()
      report.exit = await exited
      await new Promise((done) => provider.close(done))
      report.closed = true
      await writeFile(join(record, "main-path.json"), JSON.stringify(report, null, 2) + "\n")
      await writeFile(
        join(record, "结果表.md"),
        "| 步骤 | 结果 | 内容 |\n|---|---|---|\n" +
          report.steps.map((item) => "| " + item.id + " | " + item.status + " | " + item.title + " |").join("\n") +
          "\n\n真实安装/旧Beta应用内升级未验；解包产物UI证据不代替安装验收。\n",
      )
      assert.equal(report.exit.code, 0)
      assert.equal(report.exit.signal, null)
      assert.equal(report.pageErrors.length, 0)
      assert.equal(report.providerError, undefined)
    }
    return { desktop, page, report, requests, control, capture, fresh, connect, reply, tools, steer, close }
  } catch (error) {
    control.stream.resolve()
    control.steer.resolve()
    for (const response of control.responses) response.destroy()
    await desktop.close()
    report.exit = await exited
    await new Promise((done) => provider.close(done))
    report.closed = true
    report.bootstrapError = String(error)
    await writeFile(join(record, "main-path.json"), JSON.stringify(report, null, 2) + "\n")
    throw error
  }
}

if (
  typeof process !== "undefined" &&
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const run = await mainPath({
    executable: process.argv[2],
    record: process.argv[3],
    source: process.env.ZAOVRA_SOURCE_SHA,
  })
  try {
    if (process.env.ZAOVRA_MAIN_PATH_INSTALLER)
      run.report.installerSHA256 = createHash("sha256")
        .update(await readFile(process.env.ZAOVRA_MAIN_PATH_INSTALLER))
        .digest("hex")
    await run.fresh()
    run.report.steps.push({
      id: 2,
      title: "上一Beta应用内升级/保留数据/更新说明",
      status: "blocked",
      reason: "requires actual previous Beta and isolated Windows update stage",
    })
    await run.connect()
    await run.reply()
    await run.tools()
    await run.steer()
  } finally {
    await run.close()
  }
  requireMainPath(run.report, process.env.ZAOVRA_SOURCE_SHA, run.report.installerSHA256)
}
