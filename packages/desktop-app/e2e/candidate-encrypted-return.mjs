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
const attempts = new Map()
const requests = []
const result = { sourceSHA: manifest.sourceSHA, asarSHA256: digest, productAPI: 0, pass: false }
const run = await mainPath({
  executable: join(desktop, "dist/win-unpacked/Zaovra Beta.exe"),
  record,
  source: manifest.sourceSHA,
  protocol: "responses",
  async respond(body, response) {
    assert(Array.isArray(body.input), "actual Responses wire input")
    const user = body.input.findLast((item) => item.role === "user")
    const text =
      typeof user?.content === "string" ? user.content : (user?.content ?? []).map((part) => part.text ?? "").join("")
    const match = text.match(/CIPHER_(SEED|FOLLOW)_([123])/)
    assert(match, "only the six scenario prompts")
    const marker = match[0]
    const attempt = (attempts.get(marker) ?? 0) + 1
    attempts.set(marker, attempt)
    assert(attempt <= (match[1] === "FOLLOW" ? 2 : 1), "only one compatibility retry")
    requests.push({ marker, attempt, body })
    await writeFile(join(record, "requests.json"), JSON.stringify(requests, null, 2))
    const cipher = body.input.filter((item) => item.type === "reasoning" && typeof item.encrypted_content === "string")
    if (match[1] === "FOLLOW" && attempt === 1) {
      assert(
        cipher.some((item) => item.encrypted_content === `synthetic-cipher-${match[2]}`),
        "first replay includes persisted opaque state",
      )
      response.writeHead(400, { "content-type": "application/json" })
      response.end(
        JSON.stringify({
          error: {
            code: "invalid_encrypted_content",
            type: "invalid_request_error",
            message: "fixture cipher rejected",
          },
        }),
      )
      return
    }
    if (match[1] === "FOLLOW") {
      assert.equal(cipher.length, 0, "compatibility retry removes opaque reasoning")
      assert(!body.include?.includes("reasoning.encrypted_content"))
      assert(JSON.stringify(body.input).includes(`CIPHER_READY_${match[2]}`), "retry retains previous assistant answer")
      assert(JSON.stringify(body.input).includes(`CIPHER_SEED_${match[2]}`), "retry retains original user prompt")
    }
    const frames = [{ type: "response.created", response: { id: "resp_" + marker, model: "mp-returned" } }]
    if (match[1] === "SEED") {
      const item = {
        type: "reasoning",
        id: "rs_" + marker,
        summary: [],
        encrypted_content: `synthetic-cipher-${match[2]}`,
      }
      frames.push({ type: "response.output_item.added", item })
      frames.push({
        type: "response.reasoning_summary_text.delta",
        item_id: item.id,
        summary_index: 0,
        delta: "Synthetic reasoning summary",
      })
      frames.push({
        type: "response.output_item.done",
        item: { ...item, summary: [{ type: "summary_text", text: "Synthetic reasoning summary" }] },
      })
    }
    frames.push({
      type: "response.output_text.delta",
      item_id: "text_" + marker,
      delta: match[1] === "SEED" ? `CIPHER_READY_${match[2]}` : `CIPHER_RECOVERED_${match[2]}`,
    })
    frames.push({
      type: "response.completed",
      response: {
        id: "resp_" + marker,
        status: "completed",
        model: "mp-returned",
        output: [],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    })
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
    response.end(frames.map((frame) => "data: " + JSON.stringify(frame) + "\n\n").join(""))
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
  for (const cycle of [1, 2, 3]) {
    for (const action of ["SEED", "FOLLOW"]) {
      await input.fill(`CIPHER_${action}_${cycle}: 验证第二轮兼容恢复`)
      await input.press("Enter")
      await expect(
        page.getByText(`CIPHER_${action === "SEED" ? "READY" : "RECOVERED"}_${cycle}`, { exact: true }),
      ).toBeVisible()
      await expect(page.getByRole("button", { name: /^(停止|Stop)$/ })).toHaveCount(0)
    }
    await run.capture("recovered-" + cycle)
  }
  assert.equal(requests.length, 9)
  db = new DatabaseSync(join(run.report.runtime.userData, "backend/data/zaovra/zaovra.db"), { readOnly: true })
  const rows = db
    .prepare("select id,type,data from session_message order by seq")
    .all()
    .map((row) => ({ ...row, data: JSON.parse(row.data) }))
  assert.equal(rows.filter((row) => row.type === "user").length, 6)
  for (const cycle of [1, 2, 3])
    assert(JSON.stringify(rows).includes(`synthetic-cipher-${cycle}`), "persisted reasoning is not scrubbed by a retry")
  await writeFile(join(record, "messages.json"), JSON.stringify(rows, null, 2))
  result.historyCipherRetained = true
  result.pass = true
} catch (error) {
  result.failure = String(error)
  await run.capture("encrypted-failure").catch(() => {})
  process.exitCode = 1
} finally {
  db?.close()
  await run.close()
  result.closed = run.report.closed
  result.requestCount = requests.length
  result.attempts = Object.fromEntries(attempts)
  await writeFile(join(record, "encrypted-result.json"), JSON.stringify(result, null, 2))
  console.log(
    JSON.stringify({ pass: result.pass, closed: result.closed, requests: requests.length, failure: result.failure }),
  )
}
