import assert from "node:assert/strict"
import { readFile, writeFile, stat } from "node:fs/promises"
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
const hash = createHash("sha256")
  .update(await readFile(asar))
  .digest("hex")
assert.equal(
  hash,
  manifest.files.find((file) => file.path.replaceAll("\\", "/").endsWith("/win-unpacked/resources/app.asar"))?.sha256,
)
const requests = []
const released = [Promise.withResolvers(), Promise.withResolvers(), Promise.withResolvers()]
// This checks ownership and ordering; screenshots must separately verify readability.
const result = { sourceSHA: manifest.sourceSHA, asarSHA256: hash, productAPI: 0, pass: false, rounds: [] }
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
      (message) => message.role === "user" && /PARALLEL_ROUND_[012]/.test(text(message)),
    )
    assert(index >= 0, "only this scenario's prompts")
    const round = Number(text(body.messages[index]).match(/PARALLEL_ROUND_([012])/)[1])
    const done = body.messages.slice(index + 1).filter((message) => message.role === "tool")
    const tools = done.length === 0
    assert(tools || done.length === 3, "one concurrent batch, then three tool results")
    requests.push({ round, tools, outputs: done.map((message) => text(message)) })
    assert(requests.length <= 15, "three batches, answers, and bounded background completion notifications")
    if (!tools) await released[round].promise
    const delta = tools
      ? {
          role: "assistant",
          tool_calls: [0, 1, 2].map((slot) => ({
            index: slot,
            id: `call_parallel_${round}_${slot}`,
            type: "function",
            function: {
              name: "bash",
              arguments: JSON.stringify({
                command: `node -e "const fs=require('fs');fs.writeFileSync('parallel-${round}-${slot}.ready',String(Date.now()));const start=Date.now();const timer=setInterval(()=>{if(fs.existsSync('parallel-${round}-${slot}.release')){clearInterval(timer);console.log('PARALLEL_OUTPUT_${round}_${slot}');return}if(Date.now()-start>60000){clearInterval(timer);process.exit(9)}},50)"`,
                description: `PARALLEL_TOOL_${round}_${slot}`,
                run_in_background: true,
                hard_timeout_ms: 60000,
              }),
            },
          })),
        }
      : { role: "assistant", content: `PARALLEL_DONE_${round}` }
    const chunk = (value, finish_reason = null) =>
      "data: " +
      JSON.stringify({
        id: "parallel-timeline",
        object: "chat.completion.chunk",
        created: 1,
        model: "mp-returned",
        choices: [{ index: 0, delta: value, finish_reason }],
      }) +
      "\n\n"
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
    response.end(chunk(delta) + chunk({}, tools ? "tool_calls" : "stop") + "data: [DONE]\n\n")
  },
})
let db
try {
  assert.equal(run.report.runtime.version, manifest.version)
  const loaded = await run.desktop.evaluate(({ app }) => app.getAppPath())
  assert.equal(
    createHash("sha256")
      .update(await readFile(loaded))
      .digest("hex"),
    hash,
  )
  result.runtime = { ...run.report.runtime, appPath: loaded }
  await run.fresh()
  await run.connect()
  const project = join(run.report.profile, "documents", "Zaovra 项目")
  db = new DatabaseSync(join(run.report.runtime.userData, "backend/data/zaovra/zaovra.db"), { readOnly: true })
  const messages = () =>
    db
      .prepare("select id,type,data from session_message order by seq")
      .all()
      .map((row) => ({ ...row, data: JSON.parse(row.data) }))
  const input = run.page.locator('[data-component="prompt-input"][contenteditable="true"]')
  for (const order of [
    [2, 0, 1],
    [1, 2, 0],
    [2, 1, 0],
  ]) {
    const round = result.rounds.length
    const evidence = { round, releaseOrder: order, checkpoints: [] }
    result.rounds.push(evidence)
    await input.fill(`PARALLEL_ROUND_${round}: 并行执行三条固定命令`)
    await input.press("Enter")
    const permission = run.page.locator('[data-component="dock-prompt"][data-kind="permission"]')
    for (let count = 0; count < 3; count++) {
      await expect(permission).toBeVisible({ timeout: 30000 })
      await expect(permission.locator('[data-slot="permission-command"]')).toContainText(
        `parallel-${round}-${count}.ready`,
      )
      await permission.getByRole("button", { name: /允许一次/ }).click()
      await expect
        .poll(
          () =>
            stat(join(project, `parallel-${round}-${count}.ready`)).then(
              () => true,
              () => false,
            ),
          { timeout: 30000 },
        )
        .toBe(true)
    }
    await expect
      .poll(
        async () =>
          Promise.all(
            [0, 1, 2].map((slot) =>
              stat(join(project, `parallel-${round}-${slot}.ready`)).then(
                () => true,
                () => false,
              ),
            ),
          ),
        { timeout: 30000 },
      )
      .toEqual([true, true, true])
    const user = messages()
      .filter((row) => row.type === "user")
      .at(-1)
    const tools = () =>
      messages()
        .filter((row) => row.type === "assistant")
        .flatMap((row) => row.data.content)
        .filter((part) => part.type === "tool" && JSON.stringify(part).includes(`PARALLEL_TOOL_${round}_`))
    await expect.poll(() => tools().map((part) => part.state.status)).toEqual(["completed", "completed", "completed"])
    const shells = () =>
      messages().filter((row) => row.type === "shell" && row.data.command.includes(`parallel-${round}-`))
    await expect.poll(() => shells().length).toBe(3)
    assert(
      shells().every((row) => !row.data.time.completed),
      "three real background commands overlap",
    )
    evidence.userID = user.id
    evidence.toolIDs = tools().map((part) => part.id)
    evidence.readyTimes = await Promise.all(
      [0, 1, 2].map(async (slot) => Number(await readFile(join(project, `parallel-${round}-${slot}.ready`), "utf8"))),
    )
    const heading = run.page.locator(
      `[data-timeline-row="AssistantHeading"][data-message-id="${user.id}"] [data-component="turn-process-summary"] button`,
    )
    if ((await heading.getAttribute("aria-expanded")) === "false") await heading.click()
    const group = run.page.locator(`[data-message-id="${user.id}"] [data-component="process-tool-group"]`)
    await expect(group).toHaveCount(1)
    if ((await group.getAttribute("open")) === null) await group.locator(":scope > summary").click()
    const snapshot = async (label) => {
      const parts = group.locator('[data-component="tool-part-wrapper"]')
      await expect.poll(() => parts.count()).toBeGreaterThanOrEqual(3)
      const rows = await parts.evaluateAll((elements) =>
        elements.map((element) => ({
          id: element.getAttribute("data-timeline-part-id"),
          owner: element.closest("[data-message-id]")?.getAttribute("data-message-id"),
          top: element.getBoundingClientRect().top,
          height: element.getBoundingClientRect().height,
          text: element.textContent,
        })),
      )
      assert.equal(new Set(rows.map((row) => row.id)).size, rows.length, "no duplicate rendered tools")
      if (evidence.checkpoints.length)
        assert.deepEqual(
          rows.map((row) => row.id),
          evidence.checkpoints[0].rows.map((row) => row.id),
          "completion does not regroup or reorder tools",
        )
      assert(
        rows.every((row) => row.owner === user.id),
        "all tools stay in their original user turn",
      )
      assert(
        rows.every((row, index) => index === 0 || row.top >= rows[index - 1].top),
        "visual order agrees with logical order",
      )
      const layout = process.argv.includes("--assert-layout")
        ? await parts.evaluateAll((elements) =>
            elements.map((element) => {
              const label = element.querySelector('[data-slot="background-command-state"]')
              const title = element.querySelector('[data-slot="basic-tool-tool-title"]')
              const trigger = label?.closest('[data-slot="collapsible-trigger"]')
              if (!label || !title || !trigger) return { missing: true }
              const range = document.createRange()
              range.selectNodeContents(label)
              const rect = label.getBoundingClientRect(),
                outer = trigger.getBoundingClientRect(),
                heading = title.getBoundingClientRect()
              return {
                text: label.textContent,
                lines: new Set([...range.getClientRects()].map((line) => line.top)).size,
                top: rect.top,
                bottom: rect.bottom,
                left: rect.left,
                right: rect.right,
                outerTop: outer.top,
                outerBottom: outer.bottom,
                outerLeft: outer.left,
                outerRight: outer.right,
                titleTop: heading.top,
                titleBottom: heading.bottom,
              }
            }),
          )
        : undefined
      for (const item of layout ?? []) {
        assert(!item.missing, "background label and title exist")
        assert.equal(item.lines, 1, "background state remains one line")
        assert(item.top >= item.outerTop - 1 && item.bottom <= item.outerBottom + 1, "label is not vertically clipped")
        assert(item.left >= item.outerLeft && item.right <= item.outerRight, "label stays inside its trigger")
        assert(item.titleTop >= item.outerTop - 1 && item.titleBottom <= item.outerBottom + 1, "title is not clipped")
      }
      evidence.checkpoints.push({
        label,
        rows,
        layout,
        tools: tools().map((part) => ({ id: part.id, state: part.state.status })),
      })
      await writeFile(join(record, "parallel-progress.json"), JSON.stringify(result, null, 2))
    }
    await snapshot("all-running")
    await run.capture(`parallel-${round}-running`)
    if (round === 0 && process.argv.includes("--layout")) {
      evidence.layout = []
      for (const [label, css] of [
        ["baseline", ""],
        ["state-nowrap", '[data-slot="background-command-state"] { white-space: nowrap; flex-shrink: 0; }'],
        ["reverted", ""],
      ]) {
        const style = css ? await run.page.addStyleTag({ content: css }) : undefined
        await run.page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))
        const measurements = await group.evaluate((element) =>
          [...element.querySelectorAll('[data-component="tool-part-wrapper"]')].map((part) => {
            const targets = [
              '[data-slot="basic-tool-tool-title"]',
              '[data-slot="background-command-state"]',
              '[data-slot="basic-tool-tool-info-main"]',
              '[data-component="tool-trigger"]',
            ]
            return targets.map((selector) => {
              const node = part.querySelector(selector)
              if (!node) return { selector, missing: true }
              const rect = node.getBoundingClientRect(),
                style = getComputedStyle(node)
              const range = document.createRange()
              range.selectNodeContents(node)
              return {
                selector,
                text: node.textContent,
                width: rect.width,
                height: rect.height,
                x: rect.x,
                y: rect.y,
                whiteSpace: style.whiteSpace,
                flex: style.flex,
                rects: [...range.getClientRects()].map((r) => ({ width: r.width, height: r.height, x: r.x, y: r.y })),
              }
            })
          }),
        )
        evidence.layout.push({ label, measurements })
        await run.capture(`background-layout-${label}`)
        await writeFile(join(record, "layout-probe.json"), JSON.stringify(evidence.layout, null, 2))
        if (style) await style.evaluate((element) => element.remove())
      }
    }
    for (const slot of order) {
      await writeFile(join(project, `parallel-${round}-${slot}.release`), "release")
      await expect.poll(() => shells()[slot]?.data.time.completed !== undefined, { timeout: 30000 }).toBe(true)
      assert(
        shells()[slot].data.output.includes(`PARALLEL_OUTPUT_${round}_${slot}`),
        "real command result matches its slot",
      )
      await snapshot(`completed-${slot}`)
    }
    released[round].resolve()
    await expect(run.page.getByText(`PARALLEL_DONE_${round}`, { exact: true })).toBeVisible()
    await expect(run.page.getByRole("button", { name: /^(停止|Stop)$/ })).toHaveCount(0)
    if ((await heading.getAttribute("aria-expanded")) === "false") await heading.click()
    if ((await group.getAttribute("open")) === null) await group.locator(":scope > summary").click()
    await snapshot("idle")
    evidence.shells = shells()
    await run.capture(`parallel-${round}-idle`)
  }
  assert.equal(requests.filter((request) => request.tools).length, 3)
  assert.equal(messages().filter((row) => row.type === "user").length, 3)
  await writeFile(join(record, "messages.json"), JSON.stringify(messages(), null, 2))
  result.pass = true
} catch (error) {
  result.failure = String(error)
  await run.capture("parallel-failure").catch(() => {})
  process.exitCode = 1
} finally {
  released.forEach((item) => item.resolve())
  db?.close()
  await run.close()
  result.closed = run.report.closed
  result.requests = requests
  await writeFile(join(record, "parallel-result.json"), JSON.stringify(result, null, 2))
  console.log(
    JSON.stringify({ pass: result.pass, closed: result.closed, requests: requests.length, failure: result.failure }),
  )
}
