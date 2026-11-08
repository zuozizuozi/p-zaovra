import assert from "node:assert/strict"
import { join } from "node:path"
import { mainPath } from "./main-path.mjs"

export async function timelineEntries(options) {
  let missing
  let read = false
  let searched = false
  let questioned = false
  const result = { scope: "741 unfinished error and question entries only", calls: [] }
  const respond = async (body, res) => {
    const names = body.tools?.map((x) => x.function?.name) ?? []
    const tool = !read
      ? { name: "read", input: { path: missing } }
      : !questioned && names.includes("question")
        ? {
            name: "question",
            input: {
              questions: [
                {
                  header: "741入口",
                  question: "741_QUESTION_VISIBLE",
                  options: [
                    { label: "继续741", description: "确认问题卡仍可用" },
                    { label: "停下741", description: "本测试不选择" },
                  ],
                },
              ],
            },
          }
        : !searched
          ? { name: "tool_search", input: { names: ["question"] } }
          : undefined
    if (tool?.name === "read") read = true
    if (tool?.name === "tool_search") searched = true
    if (tool?.name === "question") questioned = true
    if (!tool) assert(questioned, "question tool must actually execute before completion")
    result.calls.push({ offered: names, tool: tool?.name ?? "final" })
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
    const send = (delta, finish_reason = null) =>
      res.write(
        "data: " +
          JSON.stringify({
            id: "entries741-" + result.calls.length,
            object: "chat.completion.chunk",
            created: 1,
            model: "mp-returned",
            choices: [{ index: 0, delta, finish_reason }],
          }) +
          "\n\n",
      )
    send({ role: "assistant", reasoning_content: "本轮入口检查" + result.calls.length })
    if (tool) {
      assert(names.includes(tool.name), "fixture only calls actually offered tool")
      send({
        tool_calls: [
          {
            index: 0,
            id: "entry741-" + result.calls.length,
            type: "function",
            function: { name: tool.name, arguments: JSON.stringify(tool.input) },
          },
        ],
      })
    } else send({ content: "741_ENTRIES_DONE" })
    send({}, tool ? "tool_calls" : "stop")
    res.end("data: [DONE]\n\n")
  }
  const run = await mainPath({ ...options, respond })
  try {
    await options.onRuntime?.(run)
    if (options.visualOnly) {
      await run.page.getByText("741_ENTRIES：只补真实错误与问题卡", { exact: false }).first().click()
      await run.page.getByText("需要处理", { exact: true }).first().waitFor({ state: "visible", timeout: 30000 })
      await run.page.waitForTimeout(250)
      result.visibleError = await run.page.getByText("需要处理", { exact: true }).first().isVisible()
      result.visualOnly = true
      await run.page.locator('[data-kind="tool-error-card"] [data-component="tool-trigger"]').first().click()
      await run.page.waitForTimeout(250)
      result.errorDetailsOpen = await run.page
        .locator('[data-kind="tool-error-card"]')
        .first()
        .getAttribute("data-open")
      assert.equal(result.errorDetailsOpen, "true", "error details remain clickable without expanding process summary")
      result.rendererScripts = await run.page.evaluate(() => [...document.scripts].map((x) => x.src).filter(Boolean))
      await run.capture("741-persisted-error-details-native")
      await run.capture("741-persisted-error-native")
      result.ok = true
      return result
    }
    await run.fresh()
    await run.connect()
    missing = join(run.report.runtime.documents, "Zaovra 项目", "missing-entry741.txt")
    const input = run.page.locator('[data-component="prompt-input"][contenteditable="true"]')
    await input.fill("741_ENTRIES：只补真实错误与问题卡")
    await input.press("Enter")
    const deadline = Date.now() + 30000
    const question = run.page.getByText("741_QUESTION_VISIBLE", { exact: true })
    while (!(await question.isVisible())) {
      const allow = run.page.getByRole("button", { name: "允许一次", exact: true }).first()
      if (await allow.isVisible()) await allow.click()
      assert(Date.now() < deadline, "actual question card must appear")
      await run.page.waitForTimeout(100)
    }
    result.pendingBody = await run.page.locator("body").innerText()
    result.questionVisible = true
    result.errorVisible = result.pendingBody.includes("需要处理")
    assert(result.errorVisible, "unresolved read error remains visible beside folded process details")
    result.summaryFolded = await run.page
      .locator('[data-component="turn-process-summary"] button')
      .first()
      .getAttribute("aria-expanded")
    assert.equal(result.summaryFolded, "false", "question and error do not depend on expanding process")
    await run.capture("741-question-and-error")
    await run.page.getByText("继续741", { exact: true }).click()
    await run.page.getByRole("button", { name: "提交", exact: true }).click()
    await run.page.getByText("741_ENTRIES_DONE", { exact: false }).first().waitFor({ state: "visible", timeout: 30000 })
    result.finalBody = await run.page.locator("body").innerText()
    await run.capture("741-entries-done")
    result.ok = true
  } catch (error) {
    result.error = String(error)
    result.stack = error.stack
    await run.capture("741-entry-failure").catch(() => {})
  } finally {
    await run.close().catch((error) => {
      result.closeError = String(error)
    })
    result.run = run.report
    await options.onResult?.(result)
  }
  if (!result.ok || result.closeError) throw Error(result.error ?? result.closeError)
  return result
}
