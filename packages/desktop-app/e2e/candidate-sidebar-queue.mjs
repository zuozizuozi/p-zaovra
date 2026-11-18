import assert from "node:assert/strict"
import { readFile, writeFile, stat } from "node:fs/promises"
import { createHash } from "node:crypto"
import { join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { expect } from "@playwright/test"
import { mainPath } from "./main-path.mjs"

const manifest = JSON.parse(await readFile(process.argv[2], "utf8"))
const record = resolve(process.argv[3])
const desktop = resolve(import.meta.dirname, "..")
const hash = createHash("sha256")
  .update(await readFile(join(desktop, "dist/win-unpacked/resources/app.asar")))
  .digest("hex")
assert.equal(
  hash,
  manifest.files.find((file) => file.path.replaceAll("\\", "/").endsWith("/win-unpacked/resources/app.asar"))?.sha256,
)
const requests = []
const result = {
  sourceSHA: manifest.sourceSHA,
  asarSHA256: hash,
  productAPI: 0,
  pass: false,
  checkpoints: [],
  requests,
}
const run = await mainPath({
  executable: join(desktop, "dist/win-unpacked/Zaovra Beta.exe"),
  record,
  source: manifest.sourceSHA,
  async respond(body, response) {
    const stage = requests.length
    assert(stage < 5, "only A/tool, A/final, B/tool, B/final, C/final")
    const users = body.messages
      .filter((message) => message.role === "user")
      .map((message) => JSON.stringify(message.content))
    const inputs = users.filter((text) => /QUEUE_CASE_[ABC]/.test(text))
    assert.equal(inputs.length, stage < 2 ? 1 : stage < 4 ? 2 : 3)
    assert(inputs.at(-1).includes(stage < 2 ? "QUEUE_CASE_A" : stage < 4 ? "QUEUE_CASE_B" : "QUEUE_CASE_C"))
    const outputs = body.messages.filter((message) => message.role === "tool").map((message) => message.content)
    assert.equal(outputs.length, stage === 0 ? 0 : stage < 3 ? 1 : 2)
    requests.push({ stage, inputs, outputs })
    const task = stage < 2 ? "A" : stage < 4 ? "B" : "C"
    const tool = stage === 0 || stage === 2
    if (tool) assert(body.tools.some((item) => item.function?.name === "bash"))
    const command = `node -e "const fs=require('fs');fs.writeFileSync('queue-${task}.ready',String(Date.now()));const start=Date.now();const timer=setInterval(()=>{if(fs.existsSync('queue-${task}.release')){clearInterval(timer);console.log('QUEUE_TOOL_${task}_DONE');return}if(Date.now()-start>60000){clearInterval(timer);process.exit(9)}},50)"`
    const delta = tool
      ? {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "call_queue_" + task,
              type: "function",
              function: {
                name: "bash",
                arguments: JSON.stringify({ command, description: "QUEUE_TOOL_" + task, hard_timeout_ms: 60000 }),
              },
            },
          ],
        }
      : { role: "assistant", content: "QUEUE_FINAL_" + task }
    const chunk = (value, finish_reason = null) =>
      "data: " +
      JSON.stringify({
        id: "queue-" + stage,
        object: "chat.completion.chunk",
        created: 1,
        model: "mp-returned",
        choices: [{ index: 0, delta: value, finish_reason }],
      }) +
      "\n\n"
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
    response.end(chunk(delta) + chunk({}, tool ? "tool_calls" : "stop") + "data: [DONE]\n\n")
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
  const project = join(run.report.profile, "documents", "Zaovra 项目")
  const input = run.page.locator('[data-component="prompt-input"][contenteditable="true"]')
  const permission = run.page.locator('[data-component="dock-prompt"][data-kind="permission"]')
  await input.fill("QUEUE_CASE_A：先执行A命令，再报告A完成")
  await input.press("Enter")
  await expect(permission).toBeVisible({ timeout: 30000 })
  await expect(permission.locator('[data-slot="permission-command"]')).toContainText("queue-A.ready")
  await permission.getByRole("button", { name: /允许一次/ }).click()
  await expect
    .poll(
      () =>
        stat(join(project, "queue-A.ready")).then(
          () => true,
          () => false,
        ),
      { timeout: 30000 },
    )
    .toBe(true)
  const active = run.page.locator(
    '[data-component="desktop-sidebar-v2"] [data-slot="titlebar-tab-item"][data-active="true"] [data-slot="tab-link"]',
  )
  const session = /ses_[a-zA-Z0-9]+/.exec((await active.getAttribute("href")) ?? "")?.[0]
  assert(session)
  result.session = session
  const row = run.page
    .locator('[data-component="desktop-sidebar-v2"] [data-slot="titlebar-tab-item"]')
    .filter({ has: run.page.locator('a[href*="' + session + '"]') })
  const admitted = () =>
    db
      .prepare(
        "select id,delivery,admitted_seq,promoted_seq,cancelled_seq from session_input where session_id=? order by admitted_seq",
      )
      .all(session)
  const ended = () =>
    db
      .prepare("select seq,data from event where aggregate_id=? and type like 'session.next.step.ended.%' order by seq")
      .all(session)
      .map((event) => ({ seq: event.seq, ...JSON.parse(event.data) }))
  const notification = async () =>
    Object.values(JSON.parse(await readFile(join(run.report.runtime.userData, "zaovra.global.dat"), "utf8")))
      .filter((value) => typeof value === "string" && value.includes("pendingCompletions"))
      .map((value) => JSON.parse(value))
  const notices = async () =>
    (await notification())
      .flatMap((value) => value.list)
      .filter((value) => value.session === session && value.type === "turn-complete")
  const queue = run.page.getByRole("button", { name: "任务结束后再发", exact: true })
  await expect(queue).toHaveAttribute("aria-pressed", "false")
  await queue.click()
  await expect(queue).toHaveAttribute("aria-pressed", "true")
  for (const task of ["B", "C"]) {
    await input.fill(`QUEUE_CASE_${task}：A之后按顺序执行${task}`)
    await input.press("Enter")
    await expect.poll(() => admitted().length).toBe(task === "B" ? 2 : 3)
  }
  assert.deepEqual(
    admitted().map((item) => item.delivery),
    ["steer", "queue", "queue"],
  )
  assert(admitted()[0].promoted_seq !== null)
  assert.deepEqual(
    admitted()
      .slice(1)
      .map((item) => item.promoted_seq),
    [null, null],
  )
  assert.equal(requests.length, 1)
  result.checkpoints.push({ phase: "A-running-B-C-durable-queued", inputs: admitted(), events: ended() })
  await run.capture("01-two-queued")
  await writeFile(join(project, "queue-A.release"), "release")
  await expect(permission).toBeVisible({ timeout: 30000 })
  await expect(permission.locator('[data-slot="permission-command"]')).toContainText("queue-B.ready")
  await permission.getByRole("button", { name: /允许一次/ }).click()
  await expect
    .poll(
      () =>
        stat(join(project, "queue-B.ready")).then(
          () => true,
          () => false,
        ),
      { timeout: 30000 },
    )
    .toBe(true)
  assert.equal(requests.length, 3)
  assert(admitted()[1].promoted_seq > admitted()[0].promoted_seq)
  assert.equal(admitted()[2].promoted_seq, null)
  await run.page.getByRole("button", { name: "新对话", exact: true }).last().click()
  await run.page.reload()
  await row.locator('[data-slot="session-running-ring"]').waitFor({ timeout: 15000 })
  assert.notEqual(await row.getAttribute("data-active"), "true")
  assert.equal(await row.locator('[data-slot="session-unread-dot"]').count(), 0)
  assert.equal((await notices()).length, 0)
  assert.equal(admitted()[2].promoted_seq, null)
  result.checkpoints.push({
    phase: "B-running-C-queued-after-reload",
    inputs: admitted(),
    events: ended(),
    notification: await notification(),
  })
  await run.capture("02-B-running-C-queued")
  await writeFile(join(project, "queue-B.release"), "release")
  await row.locator('[data-slot="session-unread-dot"]').waitFor({ timeout: 20000 })
  await expect(row.locator('[data-slot="session-running-ring"]')).toHaveCount(0)
  await expect.poll(async () => (await notices()).length).toBe(1)
  assert.equal(requests.length, 5)
  assert.deepEqual(
    ended().map((event) => event.finish),
    ["tool-calls", "stop", "tool-calls", "stop", "stop"],
  )
  assert(admitted()[2].promoted_seq > admitted()[1].promoted_seq)
  assert(admitted().every((item) => item.cancelled_seq === null))
  assert.equal((await notices())[0].completion, ended().at(-1).assistantMessageID)
  result.checkpoints.push({
    phase: "C-finished-only-final-notice",
    inputs: admitted(),
    events: ended(),
    notification: await notification(),
  })
  await run.capture("03-only-final-unread")
  await row.locator('[data-slot="tab-link"]').click()
  await run.page.getByText("QUEUE_FINAL_C", { exact: true }).waitFor()
  await expect(row.locator('[data-slot="session-unread-dot"]')).toHaveCount(0)
  await expect.poll(async () => (await notices())[0]?.viewed).toBe(true)
  result.checkpoints.push({ phase: "viewed-cleared", notification: await notification() })
  result.pass = true
} catch (error) {
  result.error = { message: String(error), stack: error.stack }
  await run.capture("failure").catch(() => {})
  process.exitCode = 1
} finally {
  db?.close()
  await run.close().catch((error) => {
    result.closeError = String(error)
    result.pass = false
    process.exitCode = 1
  })
  result.mainPath = run.report
  await writeFile(join(record, "sidebar-queue.json"), JSON.stringify(result, null, 2))
  console.log(
    JSON.stringify({
      pass: result.pass,
      checkpoints: result.checkpoints.length,
      closed: run.report.closed,
      error: result.error,
    }),
  )
}
