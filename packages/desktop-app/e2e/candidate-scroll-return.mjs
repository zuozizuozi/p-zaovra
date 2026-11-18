import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { expect } from "@playwright/test"
import { mainPath } from "./main-path.mjs"

const manifest = JSON.parse(await readFile(process.argv[2], "utf8"))
const record = resolve(process.argv[3])
assert(record.startsWith(resolve("F:/Zaovra-研发记录/逐次记录") + "\\"))
const desktop = resolve(import.meta.dirname, "..")
const asar = join(desktop, "dist/win-unpacked/resources/app.asar")
const digest = createHash("sha256")
  .update(await readFile(asar))
  .digest("hex")
assert.equal(
  digest,
  manifest.files.find((file) => file.path.replaceAll("\\", "/").endsWith("/win-unpacked/resources/app.asar"))?.sha256,
)
const observations = []
const reading = process.argv.includes("--assert-reading")
const chunks = Array.from({ length: 4 }, (_, index) => ({
  ready: Promise.withResolvers(),
  text: Array.from({ length: 40 }, (_, line) => `READING_CHUNK_${index}_LINE_${line}\n\n`).join(""),
}))
const end = Promise.withResolvers()
const result = { sourceSHA: manifest.sourceSHA, asarSHA256: digest, productAPI: 0, pass: false }
const run = await mainPath({
  executable: join(desktop, "dist/win-unpacked/Zaovra Beta.exe"),
  record,
  source: manifest.sourceSHA,
  async respond(body, response) {
    const text = (message) =>
      typeof message.content === "string"
        ? message.content
        : (message.content ?? []).map((part) => part.text ?? "").join("")
    const index = body.messages.findLastIndex(
      (message) => message.role === "user" && /RUNTIME_SCROLL_(\d+|TOOL|READING)/.test(text(message)),
    )
    assert(index >= 0, "only this scenario's prompts")
    const marker = text(body.messages[index]).match(/RUNTIME_SCROLL_(\d+|TOOL|READING)/)[1]
    const tool = marker === "TOOL" && !body.messages.slice(index + 1).some((message) => message.role === "tool")
    observations.push({ marker, tool })
    assert(observations.length <= (reading ? 83 : 82), "bounded history, command and optional reading turn")
    const delta = tool
      ? {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "call_scroll_return",
              type: "function",
              function: {
                name: "bash",
                arguments: JSON.stringify({
                  command: "node -e \"console.log(Array.from({length:50},(_,i)=>'SCROLL_OUTPUT_'+i).join('\\n'))\"",
                  description: "滚动验收：输出50行固定文本",
                }),
              },
            },
          ],
        }
      : {
          role: "assistant",
          content: marker === "TOOL" ? "SCROLL_COMMAND_DONE" : `HISTORY_READY_${marker}. ${"content ".repeat(30)}`,
        }
    const chunk = (delta, finish_reason = null) =>
      "data: " +
      JSON.stringify({
        id: "runtime-scroll",
        object: "chat.completion.chunk",
        created: 1,
        model: "mp-returned",
        choices: [{ index: 0, delta, finish_reason }],
      }) +
      "\n\n"
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
    if (marker === "READING") {
      assert(reading)
      response.write(chunk({ role: "assistant", content: "READING_STARTED\n\n" }))
      for (const current of chunks) {
        await current.ready.promise
        if (response.destroyed) return
        response.write(chunk({ content: current.text }))
      }
      await end.promise
      if (!response.destroyed) response.end(chunk({}, "stop") + "data: [DONE]\n\n")
      return
    }
    response.end(chunk(delta) + chunk({}, tool ? "tool_calls" : "stop") + "data: [DONE]\n\n")
  },
})
let db
let readingProbe
try {
  assert.equal(run.report.runtime.version, manifest.version)
  const appPath = await run.desktop.evaluate(({ app }) => app.getAppPath())
  assert.equal(
    createHash("sha256")
      .update(await readFile(appPath))
      .digest("hex"),
    digest,
  )
  result.runtime = { ...run.report.runtime, appPath }
  await run.fresh()
  await run.connect()
  const page = run.page
  const input = page.locator('[data-component="prompt-input"][contenteditable="true"]')
  for (let index = 0; index < 80; index++) {
    await input.fill(`RUNTIME_SCROLL_${index}: 固定历史轮次`)
    await input.press("Enter")
    await expect(page.getByText(`HISTORY_READY_${index}.`, { exact: false })).toBeVisible()
    await expect(page.getByRole("button", { name: /^(停止|Stop)$/ })).toHaveCount(0)
    await writeFile(join(record, "progress.json"), JSON.stringify({ completedHistory: index + 1 }))
  }
  await input.fill("RUNTIME_SCROLL_TOOL: 执行一次固定文本命令")
  await input.press("Enter")
  const permission = page.locator('[data-component="dock-prompt"][data-kind="permission"]')
  await permission.getByRole("button", { name: /允许一次/ }).click()
  await expect(page.getByText("SCROLL_COMMAND_DONE", { exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: /^(停止|Stop)$/ })).toHaveCount(0)
  db = new DatabaseSync(join(run.report.runtime.userData, "backend/data/zaovra/zaovra.db"), { readOnly: true })
  const rows = db
    .prepare("select id,type,data from session_message order by seq")
    .all()
    .map((row) => ({ ...row, data: JSON.parse(row.data) }))
  assert.equal(rows.filter((row) => row.type === "user").length, 81)
  const tool = rows
    .flatMap((row) => (row.type === "assistant" ? row.data.content : []))
    .find((part) => part.type === "tool" && part.name === "bash")
  assert.equal(tool?.state.status, "completed")
  result.toolID = tool.id
  await writeFile(join(record, "messages.json"), JSON.stringify(rows, null, 2))
  const user = rows.filter((row) => row.type === "user").at(-1)
  const process = page.locator(
    `[data-timeline-row="AssistantHeading"][data-message-id="${user.id}"] [data-component="turn-process-summary"] button`,
  )
  await expect(process).toHaveAttribute("aria-expanded", "false")
  await process.click()
  const group = page.locator('[data-component="process-tool-group"]')
  await expect(group).toHaveCount(1)
  await group.locator(":scope > summary").click()
  await expect(group).toHaveAttribute("open", "")
  const part = page.locator(`[data-timeline-part-id$=":${tool.id}"]`)
  await part.locator('[data-slot="collapsible-trigger"]').click()
  await expect(part.locator('[data-slot="bash-scroll"]')).toBeVisible()
  await expect(part.locator('[data-slot="bash-pre"]')).toContainText("SCROLL_OUTPUT_49")
  await run.capture("expanded-before")
  const viewport = page.locator(".scroll-view__viewport", { has: page.locator("[data-timeline-row]") })
  const box = await viewport.boundingBox()
  assert(box)
  await page.mouse.move(box.x + box.width / 2, box.y + 40)
  await page.mouse.wheel(0, -100000)
  await expect(group).toHaveCount(0)
  result.virtualRowUnmounted = true
  await run.capture("row-unmounted")
  await page.getByRole("button", { name: /最新|Jump to latest/ }).click()
  await expect(group).toHaveCount(1)
  await expect(group).toHaveAttribute("open", "")
  await expect(part.locator('[data-slot="bash-scroll"]')).toBeVisible()
  await expect(part.locator('[data-slot="bash-pre"]')).toContainText("SCROLL_OUTPUT_49")
  await run.capture("expanded-returned")
  result.returnedExpanded = true
  if (reading) {
    await input.fill("RUNTIME_SCROLL_READING: 阅读旧消息时保持位置")
    await input.press("Enter")
    await expect(page.getByText("READING_STARTED", { exact: true })).toBeVisible()
    const box = await viewport.boundingBox()
    assert(box)
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.wheel(0, -1800)
    await expect(page.getByRole("button", { name: /最新|Jump to latest/ })).toBeVisible()
    readingProbe = await viewport.evaluateHandle(async (element) => {
      // Wait for the user's wheel gesture to settle before measuring involuntary movement.
      let stable = 0
      let previous = element.scrollTop
      for (let frame = 0; frame < 180 && stable < 12; frame++) {
        await new Promise(requestAnimationFrame)
        stable = Math.abs(element.scrollTop - previous) < 0.1 ? stable + 1 : 0
        previous = element.scrollTop
      }
      if (stable < 12) throw new Error("wheel did not settle")
      const view = element.getBoundingClientRect()
      const anchor = [...element.querySelectorAll("[data-timeline-row]")].find((row) => {
        const rect = row.getBoundingClientRect()
        return (
          row.textContent.includes("HISTORY_READY_") &&
          rect.height > 0 &&
          rect.top >= view.top + 8 &&
          rect.bottom <= view.bottom - 8
        )
      })
      if (!anchor) throw new Error("no fully visible historical row")
      if (anchor.textContent.includes("READING_")) throw new Error("anchor must be historical content")
      const samples = []
      let frame
      const sample = () => {
        samples.push({
          at: performance.now(),
          top: anchor.getBoundingClientRect().top - element.getBoundingClientRect().top,
          connected: anchor.isConnected,
          scrollTop: element.scrollTop,
          scrollHeight: element.scrollHeight,
        })
        frame = requestAnimationFrame(sample)
      }
      sample()
      return {
        text: anchor.textContent,
        samples,
        stop() {
          cancelAnimationFrame(frame)
          return { text: anchor.textContent, samples }
        },
      }
    })
    result.readingChunks = []
    for (const [index, current] of chunks.entries()) {
      current.ready.resolve()
      // The active row stays rendered outside the viewport; count does not scroll it into view.
      // Streaming deltas reach the UI before the completed text is persisted to session_message.
      await expect(page.getByText(`READING_CHUNK_${index}_LINE_39`, { exact: true })).toHaveCount(1)
      await page.evaluate(async () => {
        for (let frame = 0; frame < 12; frame++) await new Promise(requestAnimationFrame)
      })
      result.readingChunks.push(await readingProbe.evaluate((value) => value.samples.at(-1)))
    }
    end.resolve()
    await expect(page.getByRole("button", { name: /^(停止|Stop)$/ })).toHaveCount(0)
    result.reading = await readingProbe.evaluate((value) => value.stop())
    await readingProbe.dispose()
    readingProbe = undefined
    const completed = JSON.parse(
      db.prepare("select data from session_message where type='assistant' order by seq desc limit 1").get().data,
    )
    assert.equal(completed.finish, "stop")
    assert.equal(
      completed.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join(""),
      "READING_STARTED\n\n" + chunks.map((current) => current.text).join(""),
    )
    result.readingCompleted = { id: completed.turn, finish: completed.finish, completed: completed.time.completed }
    result.reading.maximumDrift = Math.max(
      ...result.reading.samples.map((sample) => Math.abs(sample.top - result.reading.samples[0].top)),
    )
    assert(result.reading.samples.length > 12)
    assert(
      result.reading.samples.every((sample) => sample.connected),
      "reader's original row remains mounted",
    )
    assert(result.reading.maximumDrift <= 2, "new output must not move the historical reading anchor")
    await run.capture("reading-before-return")
    await page.getByRole("button", { name: /最新|Jump to latest/ }).click()
    await expect(page.getByText("READING_CHUNK_3_LINE_39", { exact: true })).toBeInViewport()
    await run.capture("reading-latest")
    await page.mouse.move(box.x + box.width / 2, box.y + 40)
    const first = viewport.locator(
      `[data-timeline-row="UserMessage"][data-message-id="${rows.find((row) => row.type === "user").id}"]`,
    )
    result.firstMessageWheelGestures = 0
    await expect(async () => {
      result.firstMessageWheelGestures++
      await page.mouse.wheel(0, -100000)
      await expect(first).toBeInViewport({ timeout: 1500 })
    }).toPass({ timeout: 15000, intervals: [300] })
    result.firstMessageReachable = true
    await page.getByRole("button", { name: /最新|Jump to latest/ }).click()
    await expect(page.getByText("READING_CHUNK_3_LINE_39", { exact: true })).toBeInViewport()
    result.latestReachableAgain = true
  }
  assert.equal(observations.length, reading ? 83 : 82)
  result.pass = true
} catch (error) {
  result.failure = String(error)
  await run.capture("scroll-failure").catch(() => {})
  process.exitCode = 1
} finally {
  if (readingProbe) {
    result.reading = await readingProbe.evaluate((value) => value.stop()).catch(() => undefined)
    await readingProbe.dispose()
  }
  for (const current of chunks) current.ready.resolve()
  end.resolve()
  db?.close()
  await run.close()
  result.closed = run.report.closed
  result.observations = observations
  await writeFile(join(record, "scroll-result.json"), JSON.stringify(result, null, 2))
  console.log(
    JSON.stringify({
      pass: result.pass,
      closed: result.closed,
      requests: observations.length,
      failure: result.failure,
    }),
  )
}
