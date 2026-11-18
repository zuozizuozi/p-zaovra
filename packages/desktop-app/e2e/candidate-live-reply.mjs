import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { expect } from "@playwright/test"
import { mainPath } from "./main-path.mjs"

const manifest = JSON.parse(await readFile(process.argv[2], "utf8"))
const record = resolve(process.argv[3])
const desktop = resolve(import.meta.dirname, "..")
const asar = join(desktop, "dist/win-unpacked/resources/app.asar")
const hash = createHash("sha256")
  .update(await readFile(asar))
  .digest("hex")
assert.equal(
  hash,
  manifest.files.find((file) => file.path.replaceAll("\\", "/").endsWith("/win-unpacked/resources/app.asar"))?.sha256,
)
const turns = [1, 2].map((number) => ({
  input: `LIVE_INPUT_${number}：原页面显示分段回复`,
  first: `LIVE_REPLY_${number}_FIRST`,
  tail: `_SECOND_${number}`,
  start: Promise.withResolvers(),
  next: Promise.withResolvers(),
  end: Promise.withResolvers(),
}))
const result = {
  sourceSHA: manifest.sourceSHA,
  asarSHA256: hash,
  productAPI: 0,
  pass: false,
  requests: [],
  checkpoints: [],
}
const run = await mainPath({
  executable: join(desktop, "dist/win-unpacked/Zaovra Beta.exe"),
  record,
  source: manifest.sourceSHA,
  respond: async (body, response) => {
    assert.equal(body.stream, true)
    const turn = turns[result.requests.length]
    assert(turn, "no unexpected extra provider turn")
    assert(JSON.stringify(body.messages.filter((message) => message.role === "user").at(-1)).includes(turn.input))
    result.requests.push({ turn: result.requests.length + 1, input: turn.input })
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
    const send = (delta, finish_reason = null) =>
      response.write(
        "data: " +
          JSON.stringify({
            id: `live-reply-${result.requests.length}`,
            object: "chat.completion.chunk",
            created: 1,
            model: "mp-returned",
            choices: [{ index: 0, delta, finish_reason }],
          }) +
          "\n\n",
      )
    send({ role: "assistant", ...(result.requests.length === 2 ? { reasoning_content: "第二轮先推理再输出" } : {}) })
    await turn.start.promise
    if (response.destroyed) return
    send({ content: turn.first })
    await turn.next.promise
    if (response.destroyed) return
    send({ content: turn.tail })
    await turn.end.promise
    if (response.destroyed) return
    send({}, "stop")
    response.end("data: [DONE]\n\n")
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
  db = new DatabaseSync(join(run.report.runtime.userData, "backend/data/zaovra/zaovra.db"), { readOnly: true })
  const input = run.page.locator('[data-component="prompt-input"][contenteditable="true"]')
  const timeOrigin = await run.page.evaluate(() => performance.timeOrigin)
  for (const [index, turn] of turns.entries()) {
    await input.fill(turn.input)
    await input.press("Enter")
    await expect.poll(() => result.requests.length, { timeout: 15000 }).toBe(index + 1)
    const user = run.page.locator('[data-component="user-message"]').filter({ hasText: turn.input })
    await expect(user).toHaveCount(1)
    await expect(user).toBeVisible()
    await expect(input).toHaveText("")
    await expect(
      run.page.locator('[data-component="session-followup-dock"]').filter({ hasText: turn.input }),
    ).toHaveCount(0)
    const active = run.page.locator(
      '[data-component="desktop-sidebar-v2"] [data-slot="titlebar-tab-item"][data-active="true"] [data-slot="tab-link"]',
    )
    const session = /ses_[a-zA-Z0-9]+/.exec((await active.getAttribute("href")) ?? "")?.[0]
    assert(session)
    if (index > 0) assert.equal(session, result.session)
    result.session = session
    const url = run.page.url()
    const rows = () =>
      db
        .prepare(
          "select id,delivery,admitted_seq,promoted_seq,cancelled_seq from session_input where session_id=? order by admitted_seq",
        )
        .all(session)
    const messages = () =>
      db
        .prepare("select id,type,data from session_message where session_id=? order by seq")
        .all(session)
        .map((message) => ({ id: message.id, type: message.type, value: JSON.parse(message.data) }))
    const completed = () => messages().filter((message) => message.type === "assistant" && message.value.time.completed)
    assert.equal(rows().length, index + 1)
    assert(rows()[index].promoted_seq !== null)
    assert.equal(rows()[index].cancelled_seq, null)
    assert.equal(completed().length, index)
    const mascotSelector = `[data-timeline-row="AssistantHeading"][data-message-id="${
      messages()
        .filter((message) => message.type === "user")
        .at(-1).id
    }"] [data-component="task-mascot"]`
    const mascot = process.argv.includes("--assert-mascot") ? run.page.locator(mascotSelector) : undefined
    if (mascot) await expect(mascot).toBeVisible()
    const originalMascot = mascot ? await mascot.elementHandle() : undefined
    const inspectMascot = async (phase, pose) => {
      if (!mascot) return
      await expect(mascot).toBeVisible()
      await expect(mascot).toHaveAttribute("data-pose", pose)
      await expect(run.page.locator('[data-component="task-mascot"]')).toHaveCount(1)
      const state = await originalMascot.evaluate(
        (element, selector) => ({
          connected: element.isConnected,
          sameNode: document.querySelector(selector) === element,
          state: element.getAttribute("data-state"),
          pose: element.getAttribute("data-pose"),
          owner: element.closest('[data-timeline-row="AssistantHeading"]')?.getAttribute("data-message-id"),
          width: element.getBoundingClientRect().width,
          height: element.getBoundingClientRect().height,
        }),
        mascotSelector,
      )
      assert(state.connected && state.sameNode && state.width > 0 && state.height > 0)
      result.checkpoints.push({ phase, turn: index + 1, mascot: state })
    }
    await inspectMascot("mascot-thinking", "thinking")
    result.checkpoints.push({ phase: "admitted-before-text", turn: index + 1, rows: rows(), url, timeOrigin })
    await run.capture(`turn-${index + 1}-admitted`)
    const firstAt = performance.now()
    turn.start.resolve()
    await run.page.getByText(turn.first, { exact: true }).waitFor({ timeout: 10000 })
    const firstMs = performance.now() - firstAt
    await inspectMascot("mascot-first-output", "speaking")
    assert.equal(completed().length, index, "first text appears before completion")
    assert.equal(run.page.url(), url)
    assert.equal(await run.page.evaluate(() => performance.timeOrigin), timeOrigin)
    result.checkpoints.push({ phase: "first-chunk-before-completion", turn: index + 1, firstMs })
    await run.capture(`turn-${index + 1}-first`)
    const nextAt = performance.now()
    turn.next.resolve()
    await run.page.getByText(turn.first + turn.tail, { exact: true }).waitFor({ timeout: 10000 })
    const nextMs = performance.now() - nextAt
    await inspectMascot("mascot-second-output", "speaking")
    assert.equal(completed().length, index, "second text appears while provider remains open")
    assert.equal(run.page.url(), url)
    assert.equal(await run.page.evaluate(() => performance.timeOrigin), timeOrigin)
    result.checkpoints.push({ phase: "second-chunk-before-completion", turn: index + 1, nextMs })
    turn.end.resolve()
    await expect.poll(() => completed().length, { timeout: 10000 }).toBe(index + 1)
    await expect(
      run.page.locator('[data-component="desktop-sidebar-v2"] [data-slot="session-running-ring"]'),
    ).toHaveCount(0)
    if (mascot) {
      await expect(run.page.locator('[data-component="task-mascot"]')).toHaveCount(0)
      result.checkpoints.push({ phase: "mascot-idle-hidden", turn: index + 1 })
      await originalMascot.dispose()
    }
    assert.equal(completed()[index].value.finish, "stop")
    assert.equal(
      completed()
        [index].value.content.filter((part) => part.type === "text")
        .map((part) => part.text)
        .join(""),
      turn.first + turn.tail,
    )
    result.checkpoints.push({
      phase: "completed-in-original-page",
      turn: index + 1,
      rows: rows(),
      completion: completed()[index],
    })
    await run.capture(`turn-${index + 1}-completed`)
  }
  result.pass = true
} catch (error) {
  result.error = { message: String(error), stack: error.stack }
  await run.capture("failure").catch(() => {})
  process.exitCode = 1
} finally {
  for (const turn of turns) {
    turn.start.resolve()
    turn.next.resolve()
    turn.end.resolve()
  }
  db?.close()
  await run.close().catch((error) => {
    result.closeError = String(error)
    result.pass = false
    process.exitCode = 1
  })
  result.mainPath = run.report
  await writeFile(join(record, "live-reply.json"), JSON.stringify(result, null, 2))
  console.log(
    JSON.stringify({
      pass: result.pass,
      checkpoints: result.checkpoints.length,
      closed: run.report.closed,
      error: result.error,
    }),
  )
}
