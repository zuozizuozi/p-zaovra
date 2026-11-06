import assert from "node:assert/strict"
import { mkdir, readFile, writeFile, stat } from "node:fs/promises"
import { createServer } from "node:http"
import { join, resolve } from "node:path"
import { _electron } from "playwright-core"

// Actual unpacked Dev app + isolated backend; the only model endpoint is this fixed loopback fixture.
const executable = resolve(process.argv[2])
const record = resolve(process.argv[3])
assert.equal(
  await stat(record).then(
    () => true,
    () => false,
  ),
  false,
  "fresh evidence/profile only",
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
env.ZAOVRA_DISABLE_MODELS_FETCH = "true"
const profile = join(record, "temp", "test-profile")
const project = join(profile, "documents", "Default Project")
await mkdir(project, { recursive: true })
const pdf = await readFile(new URL("../../core/test/fixtures/pdf-text.pdf", import.meta.url))
const pdfPath = join(project, "workspace.pdf")
await writeFile(pdfPath, pdf)
const processOnly = process.argv[4] === "process-only"
const revertOnly = process.argv[4] === "revert-only"
const reportPath = join(project, "report.txt")
const requests = []
const gate = Promise.withResolvers()
const held = Promise.withResolvers()
let desktop
let exitPromise
let providerError
let cancelled = false
const provider = createServer(async (req, res) => {
  try {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    if (req.method !== "POST") {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ data: [{ id: "claude-haiku-5-5" }, { id: "offline-text-only" }] }))
      return
    }
    const body = JSON.parse(Buffer.concat(chunks).toString())
    requests.push(body)
    const count = requests.length
    if (!processOnly && !revertOnly) {
      if (body.model === "offline-text-only") {
        assert(
          JSON.stringify(body.messages).includes("Zaovra PDF text fixture"),
          "real bundled PDF extraction reaches wire",
        )
        assert(!JSON.stringify(body.messages).includes('"type":"document"'), "fallback is text only")
      }
      if (count === 1)
        assert(
          body.messages.some(
            (message) => Array.isArray(message.content) && message.content.some((part) => part.type === "document"),
          ),
          "native attachment document reaches Anthropic wire",
        )
      if (count === 2) {
        const results = body.messages
          .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
          .filter((part) => part.type === "tool_result" && part.tool_use_id === "tool_read_pdf700")
        assert.equal(results.length, 1)
        assert.notEqual(results[0].is_error, true, "workspace PDF tool must actually succeed")
        assert(
          Array.isArray(results[0].content) &&
            results[0].content.some((part) => part.type === "document" && part.source?.data === pdf.toString("base64")),
          "exact workspace PDF bytes must be nested inside its tool_result",
        )
      }
      if (count === 4) {
        held.resolve()
        await gate.promise
      }
    }
    if (cancelled) {
      res.destroy()
      return
    }
    const tool = revertOnly ? false : processOnly ? [1, 2, 4].includes(count) : count === 1
    const text = revertOnly
      ? "撤回验证700已回复"
      : processOnly
        ? count < 4
          ? "报告已生成：report.txt"
          : "命令参数不完整，未执行。"
        : body.model === "offline-text-only"
          ? "文本回退已提取：Zaovra PDF text fixture"
          : count === 2
            ? "PDF附件和工作区文件读取均已完成。Zaovra PDF text fixture"
            : "本轮已完成，消息已同步：" + count
    const block =
      processOnly && tool
        ? count === 1
          ? {
              type: "tool_use",
              id: "probe700",
              name: "bash",
              input: { command: "node -e \"console.error('optional probe missing');process.exit(1)\"" },
            }
          : count === 2
            ? {
                type: "tool_use",
                id: "write700",
                name: "write",
                input: { path: reportPath, content: "verified report700" },
              }
            : { type: "tool_use", id: "bad700", name: "bash", input: {} }
        : tool
          ? { type: "tool_use", id: "tool_read_pdf700", name: "read", input: { path: pdfPath } }
          : { type: "text", text }
    if (body.stream !== true) {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(
        JSON.stringify({
          id: "fixture_" + count,
          type: "message",
          role: "assistant",
          model: body.model,
          content: [block],
          stop_reason: tool ? "tool_use" : "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 20 },
        }),
      )
      return
    }
    res.writeHead(200, { "content-type": "text/event-stream" })
    const send = (event) => res.write("event: " + event.type + "\ndata: " + JSON.stringify(event) + "\n\n")
    send({
      type: "message_start",
      message: {
        id: "fixture_" + count,
        type: "message",
        role: "assistant",
        model: body.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 0 },
      },
    })
    send({
      type: "content_block_start",
      index: 0,
      content_block: tool
        ? { type: "tool_use", id: block.id, name: block.name, input: {} }
        : { type: "text", text: "" },
    })
    send({
      type: "content_block_delta",
      index: 0,
      delta: tool
        ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) }
        : { type: "text_delta", text },
    })
    send({ type: "content_block_stop", index: 0 })
    send({
      type: "message_delta",
      delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null },
      usage: { output_tokens: 20 },
    })
    send({ type: "message_stop" })
    res.end()
  } catch (error) {
    providerError = String(error)
    res.writeHead(500, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: { type: "api_error", message: providerError } }))
  }
})
await new Promise((done) => provider.listen(0, "127.0.0.1", done))
const baseURL = "http://127.0.0.1:" + provider.address().port + "/v1"
const modelConfig = (id) => ({
  name: id,
  limit: { context: 200000, output: 8192 },
  modalities: { input: ["text", "image"], output: ["text"] },
})
const config = {
  model: "local700/claude-haiku-5-5",
  permission: { "*": "allow" },
  provider: {
    local700: {
      npm: "@ai-sdk/anthropic",
      name: "Local 700 fixture",
      options: { baseURL, apiKey: "synthetic-offline-fixture" },
      models: {
        "claude-haiku-5-5": modelConfig("claude-haiku-5-5"),
        "offline-text-only": modelConfig("offline-text-only"),
      },
    },
  },
}
const summary = {
  packaged: false,
  providerRequests: 0,
  realModelCalls: 0,
  modelKeyReads: 0,
  closed: false,
  assertions: {},
}
try {
  desktop = await _electron.launch({
    executablePath: executable,
    args: ["--user-data-dir=" + profile, "--lang=zh-CN"],
    env,
    timeout: 90000,
  })
  const child = desktop.process()
  exitPromise = new Promise((done) => child.once("exit", (code, signal) => done({ code, signal })))
  summary.pid = child.pid
  summary.runtime = await desktop.evaluate(({ app }) => ({
    packaged: app.isPackaged,
    version: app.getVersion(),
    userData: app.getPath("userData"),
  }))
  summary.packaged = summary.runtime.packaged
  assert(summary.packaged)
  assert(resolve(summary.runtime.userData).startsWith(record))
  const page = await desktop.firstWindow({ timeout: 90000 })
  page.setDefaultTimeout(30000)
  const errors = []
  page.on("pageerror", (error) => errors.push(error.message))
  summary.rendererErrors = errors
  await page
    .locator('[data-component="prompt-input"][contenteditable="true"]')
    .waitFor({ state: "visible", timeout: 90000 })
  const connection = await page.evaluate(() => window.api.awaitInitialization())
  const auth =
    "Basic " + Buffer.from((connection.username ?? "") + ":" + (connection.password ?? "")).toString("base64")
  const api = async (path, method = "GET", body) => {
    const response = await fetch(connection.url + path, {
      method,
      headers: { Authorization: auth, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    })
    const text = await response.text()
    assert(response.ok, method + " " + path + " " + response.status + " " + text.slice(0, 1000))
    return text ? JSON.parse(text) : undefined
  }
  summary.backendHealth = await api("/global/health")
  await api("/global/config", "PATCH", config)
  await api("/global/dispose", "POST")
  const openSession = async (sessionID) => {
    const windowID = await page.evaluate(() => window.api.getWindowID())
    await page.evaluate(
      ({ windowID, sessionID }) =>
        localStorage.setItem(
          "zaovra.desktop.window." + windowID + ".last-active-url",
          "/server/c2lkZWNhcg/session/" + sessionID,
        ),
      { windowID, sessionID },
    )
    await page.reload()
    await page.locator('[data-component="prompt-input"][contenteditable="true"]').waitFor({ state: "visible" })
  }
  const created = await api("/api/session", "POST", {
    agent: "build",
    model: { providerID: "local700", id: "claude-haiku-5-5" },
    location: { directory: project },
  })
  const id = created.data.id
  summary.sessionID = id
  await api("/api/session/" + id, "PATCH", { title: "700 PDF 与状态实包验证" })
  await openSession(id)

  if (revertOnly) {
    await api("/api/session/" + id + "/prompt", "POST", { id: "msg_700_revert", prompt: { text: "撤回验证700" } })
    await page.getByText("撤回验证700已回复", { exact: true }).waitFor({ state: "visible" })
    await api("/api/session/" + id + "/wait", "POST")
    assert.equal(await page.getByText("1 条已撤回的消息（可恢复）", { exact: true }).count(), 0)
    await api("/api/session/" + id + "/revert/stage", "POST", { messageID: "msg_700_revert", files: false })
    await page.getByText("1 条已撤回的消息（可恢复）", { exact: true }).waitFor({ state: "visible" })
    await page.screenshot({ path: join(record, "explicit-revert.png") })
    await api("/api/session/" + id + "/revert/clear", "POST")
    await page.getByText("1 条已撤回的消息（可恢复）", { exact: true }).waitFor({ state: "detached" })
    await page.getByText("撤回验证700已回复", { exact: true }).waitFor({ state: "visible" })
    summary.assertions.explicitRevertAndClear = true
    await page.screenshot({ path: join(record, "revert-cleared.png") })
  } else if (processOnly) {
    const waitText = async (text) => {
      const until = Date.now() + 30000
      while (Date.now() < until) {
        if (await page.getByText(text, { exact: true }).isVisible()) return
        const allow = page.getByRole("button", { name: "允许一次", exact: true })
        if (await allow.isVisible()) await allow.click()
        await new Promise((done) => setTimeout(done, 100))
      }
      throw Error("final text not visible: " + text)
    }
    await api("/api/session/" + id + "/prompt", "POST", {
      id: "msg_700_100_process",
      prompt: {
        text: "Make an optional probe, then create report.txt even if the probe fails. Report the completed file.",
      },
    })
    await waitText("报告已生成：report.txt")
    assert.equal(await readFile(reportPath, "utf8"), "verified report700")
    assert.equal(
      await page.locator('[data-slot="turn-terminal-status"]').count(),
      0,
      "probe does not turn successful delivery into a failed round",
    )
    assert.equal(await page.locator('[data-kind="tool-error-card"]').count(), 0)
    assert.equal(await page.getByText(/任务没有完成|无法读取/).count(), 0)
    summary.assertions.nonzeroProbeThenDelivery = true
    await page.screenshot({ path: join(record, "successful-delivery-after-probe.png") })
    await api("/api/session/" + id + "/prompt", "POST", {
      id: "msg_700_200_bad",
      prompt: { text: "Show the validation failure for a command missing its required arguments." },
    })
    await waitText("命令参数不完整，未执行。")
    await page.locator('[data-component="turn-process-summary"] button').last().click()
    const card = page.locator('[data-kind="tool-error-card"]')
    await card.waitFor({ state: "visible" })
    await card.locator('[data-component="tool-trigger"]').click()
    assert((await card.innerText()).includes("command"))
    assert(!(await card.innerText()).includes("SessionRunner.runTurn"))
    assert(!(await card.innerText()).includes("ToolRegistry.settle"))
    summary.assertions.readableCommandFailure = true
    await page.screenshot({ path: join(record, "command-error-details.png") })
    await api("/api/session/" + id + "/wait", "POST")
    await api("/api/session/" + id + "/revert/stage", "POST", { messageID: "msg_700_200_bad", files: false })
    await page.getByText("1 条已撤回的消息（可恢复）", { exact: true }).waitFor({ state: "visible" })
    await page.screenshot({ path: join(record, "explicit-revert.png") })
    await api("/api/session/" + id + "/revert/clear", "POST")
    await page.getByText("1 条已撤回的消息（可恢复）", { exact: true }).waitFor({ state: "detached" })
    await waitText("命令参数不完整，未执行。")
    summary.assertions.explicitRevertAndClear = true
    await page.screenshot({ path: join(record, "revert-cleared.png") })
  } else {
    await api("/api/session/" + id + "/prompt", "POST", {
      id: "msg_700_pdf",
      prompt: {
        text: "Read both the PDF attachment and workspace.pdf, then summarize the fixture.",
        files: [
          {
            mime: "application/pdf",
            uri: "data:application/pdf;base64," + pdf.toString("base64"),
            name: "attachment.pdf",
          },
        ],
      },
    })
    await page
      .getByText("PDF附件和工作区文件读取均已完成。Zaovra PDF text fixture", { exact: true })
      .waitFor({ state: "visible" })
    assert.equal(providerError, undefined)
    assert.equal(requests.length, 2)
    summary.assertions.nativeAttachment = true
    summary.assertions.workspacePdfRead = true
    summary.assertions.finalVisibleWithoutSwitch = true
    await page.screenshot({ path: join(record, "pdf-native-completed.png") })
    if (process.argv[4] !== "read-only") {
      const fallback = await api("/api/session", "POST", {
        agent: "build",
        model: { providerID: "local700", id: "offline-text-only" },
        location: { directory: project },
      })
      await openSession(fallback.data.id)
      await api("/api/session/" + fallback.data.id + "/prompt", "POST", {
        id: "msg_700_fallback",
        prompt: {
          text: "Extract the PDF text.",
          files: [
            {
              mime: "application/pdf",
              uri: "data:application/pdf;base64," + pdf.toString("base64"),
              name: "fallback.pdf",
            },
          ],
        },
      })
      await page.getByText("文本回退已提取：Zaovra PDF text fixture", { exact: true }).waitFor({ state: "visible" })
      assert.equal(providerError, undefined)
      summary.assertions.bundledTextFallback = true
      await page.screenshot({ path: join(record, "pdf-text-fallback.png") })
      await openSession(id)
      await api("/api/session/" + id + "/prompt", "POST", {
        id: "msg_700_active",
        prompt: { text: "Keep this provider request in flight while I add messages." },
      })
      await Promise.race([
        held.promise,
        new Promise((_, reject) => setTimeout(() => reject(Error("provider hold not reached")), 30000)),
      ])
      await api("/api/session/" + id + "/prompt", "POST", {
        id: "msg_700_steer",
        delivery: "steer",
        prompt: { text: "插入消息700：下一步处理" },
      })
      await api("/api/session/" + id + "/prompt", "POST", {
        id: "msg_700_queue",
        delivery: "queue",
        prompt: { text: "排队消息700：任务结束后处理" },
      })
      await page.getByText("插入消息700：下一步处理", { exact: true }).waitFor({ state: "visible" })
      await page.getByText("排队消息700：任务结束后处理", { exact: true }).waitFor({ state: "visible" })
      await page.getByText("已插入，下一步生效", { exact: true }).first().waitFor({ state: "visible" })
      await page.getByText("排队中，任务结束后发送", { exact: true }).waitFor({ state: "visible" })
      summary.assertions.steerAndQueueImmediate = true
      await page.screenshot({ path: join(record, "steer-queue-pending.png") })
      gate.resolve()
      await page.getByText("本轮已完成，消息已同步：6", { exact: true }).waitFor({ state: "visible" })
      assert.equal(providerError, undefined)
      summary.assertions.queueDrained = true
      await page.screenshot({ path: join(record, "all-messages-completed.png") })
      await writeFile(join(record, "visible-ui.txt"), await page.locator("body").innerText())
    }
  }
  summary.productProcesses = await desktop.evaluate(({ app }) =>
    app.getAppMetrics().map((item) => ({ pid: item.pid, type: item.type })),
  )
  await desktop.close()
  summary.exit = await exitPromise
  summary.closed = true
  assert.equal(summary.exit.code, 0)
  desktop = undefined
} finally {
  gate.resolve()
  cancelled = true
  if (desktop) {
    const window = desktop.windows()[0]
    if (window && !window.isClosed()) {
      await window.screenshot({ path: join(record, "failed-current.png") }).catch(() => {})
      await writeFile(
        join(record, "failed-ui.txt"),
        await window
          .locator("body")
          .innerText()
          .catch(() => "unavailable"),
      )
    }
    await desktop.close()
    if (exitPromise) summary.exit = await exitPromise
    summary.closed = true
  }
  await new Promise((done) => provider.close(done))
  provider.closeAllConnections()
  summary.providerRequests = requests.length
  summary.providerError = providerError
  await writeFile(join(record, "wire-requests.json"), JSON.stringify(requests, null, 2))
  await writeFile(join(record, "result.json"), JSON.stringify(summary, null, 2))
}
console.log(JSON.stringify(summary))
