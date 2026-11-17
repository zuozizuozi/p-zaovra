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
      (message) => message.role === "user" && /RUNTIME_SCROLL_(\d+|TOOL)/.test(text(message)),
    )
    assert(index >= 0, "only this scenario's prompts")
    const marker = text(body.messages[index]).match(/RUNTIME_SCROLL_(\d+|TOOL)/)[1]
    const tool = marker === "TOOL" && !body.messages.slice(index + 1).some((message) => message.role === "tool")
    observations.push({ marker, tool })
    assert(observations.length <= 82, "80 history responses plus one command and final answer")
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
    response.end(chunk(delta) + chunk({}, tool ? "tool_calls" : "stop") + "data: [DONE]\n\n")
  },
})
let db
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
  assert.equal(observations.length, 82)
  result.pass = true
} catch (error) {
  result.failure = String(error)
  await run.capture("scroll-failure").catch(() => {})
  process.exitCode = 1
} finally {
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
