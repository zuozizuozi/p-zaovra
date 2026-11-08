import assert from "node:assert/strict"
import { mainPath } from "./main-path.mjs"

export async function timelineScroll(options) {
  const start = Promise.withResolvers()
  const half = Promise.withResolvers()
  const warm = Promise.withResolvers()
  const resume = Promise.withResolvers()
  const result = {
    scope: "741 dedicated automatic-follow and native user-up",
    phase: options.phase,
    metrics: {},
    requests: 0,
  }
  const respond = async (_body, res) => {
    result.requests++
    assert.equal(result.requests, 1, "one fixed provider turn only")
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
    const send = (content, finish_reason = null) =>
      res.write(
        "data: " +
          JSON.stringify({
            id: "scroll741",
            object: "chat.completion.chunk",
            created: 1,
            model: "mp-returned",
            choices: [{ index: 0, delta: { content }, finish_reason }],
          }) +
          "\n\n",
      )
    send("741_SCROLL_START\n\n")
    if (options.resumeFollow) {
      for (let i = 0; i < 20; i++) {
        send("预备段落" + i + "：明确恢复跟随后测量。\n\n")
        await new Promise((done) => setTimeout(done, 18))
      }
    }
    warm.resolve()
    await start.promise
    for (let i = 0; i < 100; i++) {
      send("短段落" + i + "：这里是固定响应的阅读位置测试。\n\n")
      await new Promise((done) => setTimeout(done, 18))
      if (i === 49) {
        half.resolve()
        await resume.promise
      }
    }
    send("741_SCROLL_DONE", "stop")
    res.end("data: [DONE]\n\n")
  }
  const run = await mainPath({ ...options, respond })
  try {
    await options.onRuntime?.(run)
    await run.fresh()
    await run.connect()
    const input = run.page.locator('[data-component="prompt-input"][contenteditable="true"]')
    await input.fill("741_SCROLL_ONLY：持续输出时保住阅读位置")
    await input.press("Enter")
    await run.page.getByText("741_SCROLL_START", { exact: false }).first().waitFor({ state: "visible", timeout: 30000 })
    const viewport = run.page
      .locator(".scroll-view__viewport")
      .filter({ has: run.page.locator("[data-timeline-key]") })
      .first()
    const sample = () =>
      run.page.evaluate(async () => {
        const root = document.querySelector("[data-timeline-key]")?.closest(".scroll-view__viewport")
        if (!root) throw Error("timeline viewport missing")
        const values = []
        const start = performance.now()
        await new Promise((done) => {
          const read = () => {
            values.push({
              connected: root.isConnected,
              currentTop: document.querySelector("[data-timeline-key]")?.closest(".scroll-view__viewport")?.scrollTop,
              hash: location.hash,
              ms: performance.now() - start,
              top: root.scrollTop,
              height: root.scrollHeight,
              distance: root.scrollHeight - root.clientHeight - root.scrollTop,
            })
            if (performance.now() - start >= 1300) return done()
            requestAnimationFrame(read)
          }
          requestAnimationFrame(read)
        })
        return values
      })
    if (options.waitWarmup) {
      await warm.promise
      await run.page.getByText("预备段落19", { exact: false }).first().waitFor({ state: "visible" })
      await run.page.waitForTimeout(150)
    }
    if (options.resumeFollow) {
      await run.page.getByRole("button", { name: /最新/ }).first().click()
      result.followRequestedBy = "native jump-to-latest button"
    }
    const follow = sample()
    start.resolve()
    result.follow = await follow
    await half.promise
    result.automatic = await viewport.evaluate((root) => ({
      top: root.scrollTop,
      distance: root.scrollHeight - root.clientHeight - root.scrollTop,
    }))
    if (!options.followOnly) {
      // Native downward wheel establishes a real bottom position even if the original auto-follow misses.
      await viewport.hover()
      await run.page.mouse.wheel(0, 10000)
      await run.page.waitForTimeout(150)
      result.beforeUp = await viewport.evaluate((root) => ({
        top: root.scrollTop,
        distance: root.scrollHeight - root.clientHeight - root.scrollTop,
      }))
      await run.page.mouse.wheel(0, -320)
      await run.page.waitForTimeout(150)
      result.readingBefore = await viewport.evaluate((root) => ({
        top: root.scrollTop,
        distance: root.scrollHeight - root.clientHeight - root.scrollTop,
      }))
      assert(result.beforeUp.top - result.readingBefore.top > 100, "native wheel actually leaves bottom")
      await run.capture("741-user-up-before")
      const reading = sample()
      resume.resolve()
      result.reading = await reading
      result.readingAfter = await viewport.evaluate((root) => ({
        top: root.scrollTop,
        distance: root.scrollHeight - root.clientHeight - root.scrollTop,
      }))
      await run.capture("741-user-up-after")
    } else {
      resume.resolve()
      await run.capture("741-explicit-follow")
    }
    await run.page.getByText("741_SCROLL_DONE", { exact: false }).first().waitFor({ state: "visible", timeout: 30000 })
    if (options.verify) {
      if (options.waitWarmup)
        assert(
          result.follow.some((x) => x.top > 100 && x.connected),
          "bottom follows while chunks are still arriving, not just after sampling",
        )
      assert(result.automatic.top > 100 && result.automatic.distance <= 2, "stream automatically follows bottom")
      if (!options.followOnly)
        assert(
          Math.abs(result.readingAfter.top - result.readingBefore.top) <= 2,
          "new paragraphs preserve native user-up reading position",
        )
    }
    result.ok = true
  } catch (error) {
    result.error = String(error)
    result.stack = error.stack
    await run.capture("741-scroll-failure").catch(() => {})
  } finally {
    start.resolve()
    resume.resolve()
    await run.close().catch((error) => {
      result.closeError = String(error)
    })
    result.run = run.report
    await options.onResult?.(result)
  }
  if (!result.ok || result.closeError) throw Error(result.error ?? result.closeError)
  return result
}
