import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { mainPath } from "./main-path.mjs"

// Exercise the real question tool, server routes and UI against a loopback model.
export async function questionDock(options) {
  const report = {
    source: options.source,
    phase: options.phase,
    cases: [],
    modelRequests: [],
    api: [],
    screenshots: [],
    pageErrors: [],
    paidModelCalls: 0,
  }
  const stages = new Map()
  let active = ""
  const provider = createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ data: [{ id: "question-local", object: "model", owned_by: "local" }] }))
        return
      }
      if (req.method === "GET") {
        report.otherLocalGets ??= []
        report.otherLocalGets.push(req.url)
        res.writeHead(404).end()
        return
      }
      assert.equal(req.method, "POST")
      assert.equal(req.url, "/v1/chat/completions")
      assert.equal(req.headers.authorization, "Bearer question-synthetic")
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const bytes = Buffer.concat(chunks)
      const body = JSON.parse(bytes.toString("utf8"))
      const user = body.messages.findLast(
        (message) => message.role === "user" && /Q730-/.test(JSON.stringify(message.content)),
      )
      const id = /Q730-(open|select|skip|close|scroll|expired)/.exec(JSON.stringify(user?.content))?.[1]
      assert(id, "known bounded question scenario")
      active = id
      const stage = stages.get(id) ?? 0
      const names = body.tools?.map((tool) => tool.function.name) ?? []
      const questionAvailable = names.includes("question")
      const asked = stage === 2
      const tool = asked
        ? undefined
        : questionAvailable
          ? {
              name: "question",
              arguments: JSON.stringify({
                questions: [
                  {
                    header: "选择",
                    question: id === "scroll" ? "请确认这次操作的范围。".repeat(35) : "这次使用哪种配置方式？",
                    options: Array.from({ length: id === "scroll" ? 12 : 3 }, (_, index) => ({
                      label: "方案" + (index + 1),
                      description:
                        id === "scroll" ? "保留现有配置并核对当前工作区的约束。".repeat(8) : "保留已有配置与文件",
                    })),
                  },
                ],
              }),
            }
          : { name: "tool_search", arguments: JSON.stringify({ names: ["question"] }) }
      if (tool) assert(names.includes(tool.name), "only call an offered tool")
      stages.set(id, asked ? 3 : questionAvailable ? 2 : 1)
      report.modelRequests.push({ id, stage, tool: tool?.name, bytes: bytes.length, model: body.model })
      if (!report.systemMessages) report.systemMessages = body.messages.filter((message) => message.role === "system")
      await save()
      const content = asked ? "Q730-DONE-" + id : ""
      if (!body.stream) {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(
          JSON.stringify({
            id: "q730",
            object: "chat.completion",
            model: "question-local-returned",
            choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        )
        return
      }
      res.writeHead(200, { "content-type": "text/event-stream" })
      const send = (delta, finish_reason = null) =>
        res.write(
          "data: " +
            JSON.stringify({
              id: "q730-" + id + "-" + stage,
              object: "chat.completion.chunk",
              model: "question-local-returned",
              choices: [{ index: 0, delta, finish_reason }],
            }) +
            "\n\n",
        )
      send({ role: "assistant", content })
      if (tool) send({ tool_calls: [{ index: 0, id: "q730-" + id + "-" + stage, type: "function", function: tool }] })
      send({}, tool ? "tool_calls" : "stop")
      res.end("data: [DONE]\n\n")
    } catch (error) {
      report.providerError = String(error)
      if (!res.headersSent) res.writeHead(500)
      res.end("local question fixture failed")
    }
  })
  await new Promise((done) => provider.listen(0, "127.0.0.1", done))
  const project = join(options.profile, "documents", "Zaovra 项目")
  await mkdir(join(project, ".zaovra"), { recursive: true })
  await writeFile(
    join(project, ".zaovra", "zaovra.json"),
    JSON.stringify({ snapshots: false, permissions: [{ action: "question", resource: "*", effect: "allow" }] }) + "\n",
  )
  let run
  const save = () => writeFile(join(options.record, "question-dock.json"), JSON.stringify(report, null, 2) + "\n")
  try {
    run = await mainPath(options)
    await options.onRuntime?.(run)
    report.runtime = run.report.runtime
    report.runtime.versions = await run.desktop.evaluate(() => process.versions)
    const page = run.page
    page.on("pageerror", (error) => report.pageErrors.push(error.message))
    const pending = []
    let serverRequest
    page.on("request", (request) => {
      if (/\/api\/session\//.test(request.url()))
        serverRequest = { url: request.url(), authorization: request.headers().authorization }
    })
    page.on("response", (response) => {
      if (/\/question\/[^/]+\/(reply|reject)/.test(response.url()))
        pending.push(
          (response.status() === 204 ? Promise.resolve("") : response.text())
            .then((body) =>
              report.api.push({
                case: active,
                url: response.url(),
                status: response.status(),
                body,
                requestBody: response.request().postData(),
              }),
            )
            .catch((error) => {
              report.responseCaptureError = String(error)
            }),
        )
    })
    const window = await run.desktop.browserWindow(page)
    await window.evaluate((win) => {
      win.setSize(1280, 720)
      win.showInactive()
    })
    const input = page.locator('[data-component="prompt-input"][contenteditable="true"]')
    await input.waitFor({ state: "visible", timeout: 90000 })
    await page.keyboard.press("Control+,")
    await page.getByRole("tab", { name: "模型服务", exact: true }).click()
    await page
      .locator('[data-component="custom-provider-section"]')
      .getByRole("button", { name: "连接", exact: true })
      .click()
    await page.getByLabel("基础 URL", { exact: true }).fill("http://127.0.0.1:" + provider.address().port + "/v1")
    await page.getByLabel("API 密钥", { exact: true }).fill("question-synthetic")
    await page.locator("details > summary").filter({ hasText: "高级设置" }).click()
    await page.getByLabel("兼容协议", { exact: true }).selectOption("openai")
    await page.getByRole("button", { name: "获取模型", exact: true }).click()
    await page.getByText("question-local", { exact: true }).first().waitFor({ state: "visible" })
    await page.getByRole("button", { name: "保存配置", exact: true }).click()
    await page.getByRole("dialog").waitFor({ state: "hidden" })
    await page.getByRole("button", { name: "关闭", exact: true }).click()
    const capture = async (name) => {
      await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))
      const encoded = await window.evaluate(async (win) => {
        const image = await win.capturePage(undefined, { stayHidden: true, stayAwake: true })
        if (image.isEmpty()) throw new Error("native screenshot empty")
        return image.toJPEG(85).toString("base64")
      })
      const bytes = Buffer.from(encoded, "base64")
      assert(bytes.length > 0)
      await writeFile(join(options.record, name + ".jpg"), bytes)
      report.screenshots.push(name + ".jpg")
    }
    const card = page.locator('[data-component="session-question-dock"]')
    for (const id of options.cases ?? ["open", "select", "skip", "close", "scroll", "expired"]) {
      const item = { id, status: "running" }
      report.cases.push(item)
      try {
        active = id
        if (id !== "open") await page.getByRole("button", { name: "新对话", exact: true }).last().click()
        await input.waitFor({ state: "visible" })
        await page.waitForFunction(() =>
          document.querySelector('[data-action="prompt-model"]')?.innerText.includes("question-local"),
        )
        const start = performance.now()
        await input.fill("Q730-" + id + "：请用问题工具让我选择配置。")
        await input.press("Enter")
        await card.waitFor({ state: "visible", timeout: 60000 })
        item.openMs = performance.now() - start
        await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))
        item.metrics = await card.evaluate((element) => {
          const box = element.getBoundingClientRect()
          const content = element.querySelector('[data-slot="question-content"]')
          const opts = element.querySelector('[data-slot="question-options"]')
          const footer = element.querySelector('[data-slot="question-footer"]')?.getBoundingClientRect()
          return {
            x: box.x,
            y: box.y,
            width: box.width,
            height: box.height,
            viewport: { width: innerWidth, height: innerHeight },
            options: {
              height: opts.clientHeight,
              scrollHeight: opts.scrollHeight,
              overflowY: getComputedStyle(opts).overflowY,
            },
            content: {
              height: content.clientHeight,
              scrollHeight: content.scrollHeight,
              overflowY: getComputedStyle(content).overflowY,
            },
            footer: footer && { top: footer.top, bottom: footer.bottom },
          }
        })
        await save()
        await capture(id + "-open")
        if (id === "scroll") {
          const scroller = card.locator('[data-slot="question-content"]')
          const bounds = await scroller.boundingBox()
          assert(bounds)
          const before = await scroller.evaluate((el) => el.scrollTop)
          await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
          await page.mouse.wheel(0, 900)
          await page.waitForTimeout(150)
          item.scroll = { before, after: await scroller.evaluate((el) => el.scrollTop) }
          await capture("scroll-after-wheel")
          assert(item.scroll.after > before, "question content accepts a real wheel scroll")
          assert(item.metrics.footer.bottom <= item.metrics.viewport.height, "footer remains in viewport")
          await card.getByRole("button", { name: "关闭", exact: true }).click()
        } else if (id === "expired") {
          const href = await page
            .locator('[data-component="desktop-sidebar-v2"] [data-active="true"] [data-slot="tab-link"]')
            .getAttribute("href")
          const sessionID = /ses_[a-zA-Z0-9]+/.exec(href)?.[0]
          assert(sessionID && serverRequest)
          const url = new URL("/api/session/" + sessionID + "/interrupt", serverRequest.url).href
          item.interruptStatus = await page.evaluate(
            async ({ url, authorization }) =>
              (await fetch(url, { method: "POST", headers: authorization ? { authorization } : {} })).status,
            { url, authorization: serverRequest.authorization },
          )
          assert.equal(item.interruptStatus, 204)
          await page.waitForTimeout(200)
          item.staleVisible = await card.isVisible()
          if (item.staleVisible) await card.getByRole("button", { name: "关闭", exact: true }).click()
        } else if (id === "skip" || id === "close") {
          await card.getByRole("button", { name: id === "skip" ? "跳过" : "关闭", exact: true }).click()
        } else {
          const choices = card.locator('button[data-slot="question-option"]')
          await page.keyboard.press(id === "select" ? "2" : "1")
          await choices
            .nth(id === "select" ? 1 : 0)
            .getAttribute("aria-checked")
            .then((value) => assert.equal(value, "true"))
          await card.getByRole("button", { name: "提交", exact: true }).click()
        }
        await card.waitFor({ state: "hidden", timeout: 10000 })
        await page.getByRole("button", { name: /^(停止|Stop)$/ }).waitFor({ state: "hidden", timeout: 10000 })
        await Promise.all(pending)
        const api = report.api.filter((entry) => entry.case === id)
        if (id === "expired") {
          if (item.staleVisible) assert.equal(api.at(-1)?.status, 404, "expired request really no longer exists")
        } else {
          assert.equal(api.length, 1, "one settlement request")
          assert.equal(api[0].status, 204, "real server accepts settlement")
        }
        item.afterText = (await page.locator("body").innerText()).slice(-3000)
        assert(!/请求失败|服务器请求未完成/.test(item.afterText), "no failed-request toast")
        await capture(id + "-settled")
        if (id === "open") {
          assert(item.metrics.height <= 340, "compact question card stays below 340px at 720px")
          assert(item.metrics.width <= 640, "question card is narrower than the composer")
        }
        item.status = "pass"
      } catch (error) {
        item.status = "fail"
        item.error = String(error)
        item.afterText = (await page.locator("body").innerText()).slice(-4000)
        await capture(id + "-failure").catch((error) => {
          item.screenshotError = String(error)
        })
      }
      await save()
    }
    await Promise.all(pending)
  } finally {
    if (run) {
      await options.onClosing?.(run)
      await run.close().catch((error) => {
        report.closeError = String(error)
      })
      report.closed = run.report.closed
      report.exit = run.report.exit
      report.bootstrap = run.report
    }
    await new Promise((done) => provider.close(done))
    report.providerClosed = true
    await save()
  }
  report.languageInstruction = report.systemMessages?.some(
    (message) =>
      message.content.includes("Respond in the user's language") &&
      message.content.includes("conversation's established language"),
  )
  await save()
  if (options.phase.startsWith("final"))
    assert.equal(report.languageInstruction, true, "actual production model request contains language guidance")
  assert.equal(report.responseCaptureError, undefined)
  assert.equal(report.providerError, undefined)
  assert.equal(report.closeError, undefined)
  assert.equal(report.pageErrors.length, 0)
  assert(
    report.cases.every((item) => item.status === "pass"),
    "all question interactions pass",
  )
  return report
}
