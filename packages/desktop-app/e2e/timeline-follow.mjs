import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { mainPath } from "./main-path.mjs"

export async function timelineFollow(options) {
  const stages = {
    second: Promise.withResolvers(),
    third: Promise.withResolvers(),
    fourth: Promise.withResolvers(),
    finishSecond: Promise.withResolvers(),
    wave: Promise.withResolvers(),
    half: Promise.withResolvers(),
    resumeWave: Promise.withResolvers(),
  }
  let turn = 0
  let proof
  const result = {
    scope: "741 production timeline multi-turn and short chunks",
    source: options.source,
    phase: options.phase,
    metrics: {},
    snapshots: [],
    frames: [],
    screenshots: [],
    calls: [],
  }
  const respond = async (body, response) => {
    const current = ++turn
    result.calls.push({ turn: current, messages: body.messages.length })
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
    const send = (delta, finish = null) =>
      response.write(
        "data: " +
          JSON.stringify({
            id: "tf741-" + current,
            object: "chat.completion.chunk",
            created: 1,
            model: "mp-returned",
            choices: [{ index: 0, delta, finish_reason: finish }],
          }) +
          "\n\n",
      )
    send({ role: "assistant" })
    send({ reasoning_content: "741思考片段" + current })
    await new Promise((done) => setTimeout(done, 45))
    send({ reasoning_content: "：检查当前步骤。" })
    send({ content: "741-TURN-" + current + "\n" })
    if (current === 2) {
      stages.second.resolve()
      await stages.finishSecond.promise
    }
    if (current === 3) {
      stages.third.resolve()
      await stages.wave.promise
      for (let i = 0; i < 60; i++) {
        send({ content: "短增量" + String(i).padStart(2, "0") + "：保持用户的阅读位置。\n" })
        await new Promise((done) => setTimeout(done, 18))
        if (i === 29) {
          stages.half.resolve()
          await stages.resumeWave.promise
        }
      }
    }
    if (current === 4) stages.fourth.resolve()
    const tool =
      current <= 2
        ? { name: "read", input: { path: proof } }
        : current === 4
          ? { name: "bash", input: { command: 'node -e "process.exit(7)"', description: "741允许一次后返回受控错误7" } }
          : undefined
    if (tool) {
      assert(
        body.tools?.some((x) => x.function?.name === tool.name),
        "fixed fixture only calls offered tool " + tool.name,
      )
      send({
        tool_calls: [
          {
            index: 0,
            id: "call_tf741_" + current,
            type: "function",
            function: { name: tool.name, arguments: JSON.stringify(tool.input) },
          },
        ],
      })
    }
    if (current >= 5) send({ content: "741_FINAL_DONE" })
    send({}, tool ? "tool_calls" : "stop")
    response.end("data: [DONE]\n\n")
  }
  const started = performance.now()
  const run = await mainPath({ ...options, respond })
  try {
    await options.onRuntime?.(run)
    await run.fresh()
    result.metrics.readyMs = performance.now() - started
    await run.connect()
    proof = join(run.report.runtime.documents, "Zaovra 项目", "proof741.txt")
    await writeFile(proof, "READ741-PASS")
    const input = run.page.locator('[data-component="prompt-input"][contenteditable="true"]')
    await input.fill("741_FIRST：多轮过程与短增量")
    const promptAt = performance.now()
    await input.press("Enter")
    await run.page.getByText("741-TURN-1", { exact: false }).first().waitFor({ state: "visible", timeout: 30000 })
    result.metrics.firstTextMs = performance.now() - promptAt
    await Promise.race([
      stages.second.promise,
      new Promise((_, reject) => setTimeout(() => reject(Error("second provider turn timeout")), 30000).unref()),
    ])
    if (options.verify) {
      await run.page.locator('[data-action="session-conversation-view"]').click()
      await run.page.getByText("思考", { exact: true }).last().click()
    }
    await run.page.waitForTimeout(150)
    const snapshot = async (name) => {
      const value = await run.page.evaluate(() => {
        const row = document.querySelector("[data-timeline-key]")
        const root = row?.closest(".scroll-view__viewport")
        return {
          reasoning: [...document.querySelectorAll('[data-component="reasoning-block"]')].filter(
            (x) => x.offsetParent !== null,
          ).length,
          summaries: [...document.querySelectorAll('[data-component="turn-process-summary"]')]
            .filter((x) => x.offsetParent !== null)
            .map((x) => ({ text: x.textContent, height: x.getBoundingClientRect().height })),
          headers: [...document.querySelectorAll('[data-slot="assistant-heading"]')].map((x) => ({
            text: x.textContent,
            height: x.getBoundingClientRect().height,
          })),
          top: root?.scrollTop,
          height: root?.scrollHeight,
          viewport: root?.clientHeight,
        }
      })
      result.snapshots.push({ name, ...value })
    }
    await snapshot("two-rounds")
    if (options.verify) {
      const first = result.snapshots.at(-1)
      assert.equal(first.reasoning, 0, "thoughts do not add collapsed rows")
      assert.equal(first.headers.length, 1, "one resident summary per display turn")
      assert(/思考\s*2\s*条/.test(first.headers[0].text), "two distinct parts accumulate, not stream chunk count")
      const toggle = run.page.locator('[data-component="turn-process-summary"]').first().getByRole("button")
      await toggle.click()
      await run.page.locator('[data-component="reasoning-block"]').first().waitFor({ state: "visible" })
      result.expandedReasoning = await run.page
        .locator('[data-component="reasoning-block"]')
        .evaluateAll((xs) => xs.filter((x) => x.offsetParent !== null).length)
      assert(result.expandedReasoning >= 2, "thought details remain expandable")
      await run.capture("741-expanded-details")
      result.screenshots.push("741-expanded-details.jpg")
      await toggle.click()
      await run.page.waitForTimeout(80)
    }
    await run.capture("741-two-rounds")
    result.screenshots.push("741-two-rounds.jpg")
    stages.finishSecond.resolve()
    await Promise.race([
      stages.third.promise,
      new Promise((_, reject) => setTimeout(() => reject(Error("third provider turn timeout")), 30000).unref()),
    ])
    await input.fill("741_SECOND：交错发送并保留阅读位置")
    await input.press("Enter")
    await run.page.waitForTimeout(150)
    await snapshot("third-with-steer")
    const root = run.page
      .locator(".scroll-view__viewport")
      .filter({ has: run.page.locator("[data-timeline-key]") })
      .first()
    const sample = () =>
      run.page.evaluate(async () => {
        const root = document.querySelector("[data-timeline-key]")?.closest(".scroll-view__viewport")
        if (!root) throw Error("actual timeline viewport missing")
        const values = []
        const start = performance.now()
        await new Promise((done) => {
          const read = () => {
            values.push({
              ms: performance.now() - start,
              top: root.scrollTop,
              height: root.scrollHeight,
              distance: root.scrollHeight - root.clientHeight - root.scrollTop,
            })
            if (performance.now() - start > 1500) return done()
            requestAnimationFrame(read)
          }
          requestAnimationFrame(read)
        })
        return values
      })
    const framePromise = sample()
    stages.wave.resolve()
    result.frames = await framePromise
    await stages.half.promise
    await root.hover()
    await run.page.mouse.wheel(0, -350)
    await run.page.waitForTimeout(100)
    const anchor = () =>
      run.page.evaluate(() => {
        const root = document.querySelector("[data-timeline-key]")?.closest(".scroll-view__viewport")
        if (!root) throw Error("timeline root missing")
        const view = root.getBoundingClientRect()
        const first = [...root.querySelectorAll("[data-timeline-key]")]
          .filter(
            (x) =>
              x.getBoundingClientRect().height > 0 &&
              x.getBoundingClientRect().bottom > view.top &&
              x.getBoundingClientRect().top < view.bottom,
          )
          .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0]
        return {
          key: first?.getAttribute("data-timeline-key"),
          offset: first ? first.getBoundingClientRect().top - view.top : undefined,
          top: root.scrollTop,
          distance: root.scrollHeight - root.clientHeight - root.scrollTop,
        }
      })
    result.readingBefore = await anchor()
    const reading = sample()
    stages.resumeWave.resolve()
    result.readingFrames = await reading
    result.readingAfter = await anchor()
    await run.page.waitForTimeout(150)
    await snapshot("after-short-chunks")
    await run.capture("741-short-chunks")
    result.screenshots.push("741-short-chunks.jpg")
    await Promise.race([
      stages.fourth.promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(Error("second input not admitted into next turn")), 30000).unref(),
      ),
    ])
    const allow = run.page.getByRole("button", { name: "允许一次", exact: true }).first()
    await allow.waitFor({ state: "visible", timeout: 30000 })
    result.permissionVisible = true
    await run.capture("741-permission-entry")
    result.screenshots.push("741-permission-entry.jpg")
    await allow.click()
    await run.page.getByText("741_FINAL_DONE", { exact: false }).first().waitFor({ state: "visible", timeout: 30000 })
    await run.page.waitForTimeout(300)
    await snapshot("completed")
    result.finalBody = await run.page.locator("body").innerText()
    if (options.verify) {
      const completed = result.snapshots.at(-1)
      assert.equal(completed.headers.length, 2, "interleaved user input creates two display turns")
      assert(
        completed.headers.every((x) => x.height === 36),
        "active and settled summary stay one fixed-height line",
      )
      assert(/思考\s*3\s*条/.test(completed.headers[0].text), "first display turn has three thoughts")
      assert(/思考\s*2\s*条/.test(completed.headers[1].text), "second display turn has its own two thoughts")
      assert.equal(completed.reasoning, 0, "thought details return to collapsed state")
      assert(
        result.permissionVisible && result.finalBody.includes("命令没有成功执行"),
        "permission and nonzero-command notice remain visible",
      )
    }

    await run.capture("741-completed")
    result.screenshots.push("741-completed.jpg")
    result.ok = true
  } catch (error) {
    result.error = String(error)
    result.stack = error.stack
    await run.capture("741-failure").catch(() => {})
  } finally {
    stages.finishSecond.resolve()
    stages.wave.resolve()
    stages.resumeWave.resolve()
    await run.close().catch((error) => {
      result.closeError = String(error)
    })
    result.run = run.report
    await options.onResult?.(result)
  }
  if (!result.ok || result.closeError) throw Error(result.error ?? result.closeError)
  return result
}
