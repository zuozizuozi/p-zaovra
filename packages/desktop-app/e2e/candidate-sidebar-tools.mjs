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
const asar = join(desktop, "dist/win-unpacked/resources/app.asar")
const hash = createHash("sha256")
  .update(await readFile(asar))
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
    const outputs = body.messages.filter((message) => message.role === "tool")
    const stage = outputs.length
    assert.equal(stage, requests.length, "each provider turn follows exactly one settled tool")
    assert(stage <= 2, "only two tool turns and final answer")
    requests.push({ stage, outputs: outputs.map((message) => message.content) })
    const command =
      stage === 0
        ? "node -e \"require('fs').writeFileSync('sidebar-0.ready','FIRST_DONE');console.log('SIDEBAR_FIRST_DONE')\""
        : "node -e \"const fs=require('fs');fs.writeFileSync('sidebar-1.ready',String(Date.now()));const start=Date.now();const timer=setInterval(()=>{if(fs.existsSync('sidebar-1.release')){clearInterval(timer);console.log('SIDEBAR_SECOND_DONE');return}if(Date.now()-start>60000){clearInterval(timer);process.exit(9)}},50)\""
    if (stage < 2) assert(body.tools?.some((tool) => tool.function?.name === "bash"))
    const delta =
      stage < 2
        ? {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "call_sidebar_" + stage,
                type: "function",
                function: {
                  name: "bash",
                  arguments: JSON.stringify({ command, description: "SIDEBAR_STEP_" + stage, hard_timeout_ms: 60000 }),
                },
              },
            ],
          }
        : { role: "assistant", content: "SIDEBAR_FINAL_COMPLETE" }
    const chunk = (value, finish_reason = null) =>
      "data: " +
      JSON.stringify({
        id: "sidebar-tools",
        object: "chat.completion.chunk",
        created: 1,
        model: "mp-returned",
        choices: [{ index: 0, delta: value, finish_reason }],
      }) +
      "\n\n"
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
    response.end(chunk(delta) + chunk({}, stage < 2 ? "tool_calls" : "stop") + "data: [DONE]\n\n")
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
  await input.fill("SIDEBAR_TWO_STEPS：执行两个命令，然后报告完成")
  await input.press("Enter")
  const permission = run.page.locator('[data-component="dock-prompt"][data-kind="permission"]')
  for (const stage of [0, 1]) {
    await expect(permission).toBeVisible({ timeout: 30000 })
    await expect(permission.locator('[data-slot="permission-command"]')).toContainText(`sidebar-${stage}.ready`)
    await permission.getByRole("button", { name: /允许一次/ }).click()
    await expect
      .poll(
        () =>
          stat(join(project, `sidebar-${stage}.ready`)).then(
            () => true,
            () => false,
          ),
        { timeout: 30000 },
      )
      .toBe(true)
  }
  const active = run.page.locator(
    '[data-component="desktop-sidebar-v2"] [data-slot="titlebar-tab-item"][data-active="true"] [data-slot="tab-link"]',
  )
  const session = /ses_[a-zA-Z0-9]+/.exec((await active.getAttribute("href")) ?? "")?.[0]
  assert(session)
  result.session = session
  const row = run.page
    .locator('[data-component="desktop-sidebar-v2"] [data-slot="titlebar-tab-item"]')
    .filter({ has: run.page.locator('a[href*="' + session + '"]') })
  const ended = () =>
    db
      .prepare("select seq,data from event where aggregate_id=? and type like 'session.next.step.ended.%' order by seq")
      .all(session)
      .map((event) => ({ seq: event.seq, ...JSON.parse(event.data) }))
  const tools = () =>
    db
      .prepare("select data from session_message where session_id=? and type='assistant' order by seq")
      .all(session)
      .flatMap((message) => JSON.parse(message.data).content)
      .filter((part) => part.type === "tool")
  const notification = async () =>
    Object.values(JSON.parse(await readFile(join(run.report.runtime.userData, "zaovra.global.dat"), "utf8")))
      .filter((value) => typeof value === "string" && value.includes("pendingCompletions"))
      .map((value) => JSON.parse(value))
  const notices = async () =>
    (await notification())
      .flatMap((value) => value.list)
      .filter((value) => value.session === session && value.type === "turn-complete")
  await expect.poll(() => ended().length).toBe(1)
  await expect.poll(() => tools().map((part) => part.state.status)).toEqual(["completed", "running"])
  await run.page.getByRole("button", { name: "新对话", exact: true }).last().click()
  await expect(row).not.toHaveAttribute("data-active", "true")
  await row.locator('[data-slot="session-running-ring"]').waitFor()
  await expect.poll(async () => (await notification()).some((value) => value.pendingCompletions[session])).toBeTruthy()
  assert.equal((await notices()).length, 0)
  result.checkpoints.push({
    phase: "first-ended-second-running",
    events: ended(),
    tools: tools(),
    notification: await notification(),
  })
  await run.capture("01-tool-running-before-reload")
  await run.page.reload()
  await row.locator('[data-slot="session-running-ring"]').waitFor({ timeout: 15000 })
  assert.notEqual(await row.getAttribute("data-active"), "true")
  assert.equal(await row.locator('[data-slot="session-unread-dot"]').count(), 0)
  assert.equal((await notices()).length, 0)
  assert.deepEqual(
    tools().map((part) => part.state.status),
    ["completed", "running"],
  )
  assert.equal(ended().length, 1)
  result.checkpoints.push({
    phase: "reloaded-still-busy-no-early-unread",
    events: ended(),
    tools: tools(),
    notification: await notification(),
  })
  await run.capture("02-reloaded-tool-still-running")
  await writeFile(join(project, "sidebar-1.release"), "release")
  await row.locator('[data-slot="session-unread-dot"]').waitFor({ timeout: 15000 })
  assert.equal(await row.locator('[data-slot="session-running-ring"]').count(), 0)
  await expect.poll(async () => (await notices()).length).toBe(1)
  assert.equal(ended().length, 3)
  assert.deepEqual(
    tools().map((part) => part.state.status),
    ["completed", "completed"],
  )
  assert.equal((await notices())[0].completion, ended().at(-1).assistantMessageID)
  result.checkpoints.push({
    phase: "three-steps-one-final-notice",
    events: ended(),
    tools: tools(),
    notification: await notification(),
  })
  await run.capture("03-final-unread")
  await row.locator('[data-slot="tab-link"]').click()
  await run.page.getByText("SIDEBAR_FINAL_COMPLETE", { exact: true }).waitFor()
  await expect(row.locator('[data-slot="session-unread-dot"]')).toHaveCount(0)
  await expect.poll(async () => (await notices())[0]?.viewed).toBe(true)
  result.checkpoints.push({ phase: "viewed-cleared", notification: await notification() })
  assert.equal(requests.length, 3)
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
  await writeFile(join(record, "sidebar-tools.json"), JSON.stringify(result, null, 2))
  console.log(
    JSON.stringify({
      pass: result.pass,
      checkpoints: result.checkpoints.length,
      closed: run.report.closed,
      error: result.error,
    }),
  )
}
