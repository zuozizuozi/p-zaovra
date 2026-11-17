import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { join, resolve } from "node:path"
import { expect } from "@playwright/test"
import { mainPath } from "./main-path.mjs"

const manifest = JSON.parse(await readFile(process.argv[2], "utf8"))
const record = resolve(process.argv[3])
assert(record.startsWith(resolve("F:/Zaovra-研发记录/逐次记录") + "\\"))
const desktop = resolve(import.meta.dirname, "..")
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex")
const asar = join(desktop, "dist/win-unpacked/resources/app.asar")
const hash = digest(await readFile(asar))
assert.equal(
  hash,
  manifest.files.find((file) => file.path.replaceAll("\\", "/").endsWith("/win-unpacked/resources/app.asar"))?.sha256,
)
const observations = []
const result = { sourceSHA: manifest.sourceSHA, asarSHA256: hash, productAPI: 0, samples: [], closed: false }
const run = await mainPath({
  executable: join(desktop, "dist/win-unpacked/Zaovra Beta.exe"),
  record,
  source: manifest.sourceSHA,
  async respond(body, response) {
    const last = body.messages.findLastIndex(
      (message) => message.role === "user" && JSON.stringify(message).includes("LAYOUT_PROBE"),
    )
    assert(JSON.stringify(body.messages[last]).includes("LAYOUT_PROBE"))
    const done = body.messages.slice(last + 1).filter((message) => message.role === "tool")
    assert(done.length === 0 || done.length === 3)
    observations.push({ toolResults: done.length })
    assert(observations.length <= 2)
    const delta = done.length
      ? { role: "assistant", content: "LAYOUT_DONE" }
      : {
          role: "assistant",
          tool_calls: [0, 1, 2].map((slot) => ({
            index: slot,
            id: `call_layout_${slot}`,
            type: "function",
            function: {
              name: "bash",
              arguments: JSON.stringify({
                command: `node -e "console.log('LAYOUT_OUTPUT_${slot}')"`,
                description: `LAYOUT_COMMAND_${slot}`,
              }),
            },
          })),
        }
    const chunk = (value, finish_reason = null) =>
      "data: " +
      JSON.stringify({
        id: "layout-probe",
        object: "chat.completion.chunk",
        created: 1,
        model: "mp-returned",
        choices: [{ index: 0, delta: value, finish_reason }],
      }) +
      "\n\n"
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
    response.end(chunk(delta) + chunk({}, done.length ? "stop" : "tool_calls") + "data: [DONE]\n\n")
  },
})
try {
  assert.equal(run.report.runtime.version, manifest.version)
  const loaded = await run.desktop.evaluate(({ app }) => app.getAppPath())
  assert.equal(digest(await readFile(loaded)), hash)
  result.runtime = { ...run.report.runtime, appPath: loaded }
  await run.fresh()
  await run.connect()
  const page = run.page
  await page.locator('[data-component="prompt-input"][contenteditable="true"]').fill("LAYOUT_PROBE: 执行三条固定命令")
  await page.locator('[data-component="prompt-input"][contenteditable="true"]').press("Enter")
  const permission = page.locator('[data-component="dock-prompt"][data-kind="permission"]')
  for (let slot = 0; slot < 3; slot++) {
    await expect(permission.locator('[data-slot="permission-command"]')).toContainText(`LAYOUT_OUTPUT_${slot}`, {
      timeout: 30000,
    })
    await permission.getByRole("button", { name: /允许一次/ }).click()
  }
  await expect(page.getByText("LAYOUT_DONE", { exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: /^(停止|Stop)$/ })).toHaveCount(0)
  const summary = page.locator('[data-component="turn-process-summary"] button')
  if ((await summary.getAttribute("aria-expanded")) === "false") await summary.click()
  const group = page.locator('[data-component="process-tool-group"]')
  await expect(group).toHaveCount(1)
  if ((await group.getAttribute("open")) === null) await group.locator(":scope > summary").click()
  await expect(group.locator('[data-component="tool-part-wrapper"]')).toHaveCount(3)
  const measure = async (label) => {
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const sample = await group.evaluate((element) => {
      const describe = (node) => {
        const css = getComputedStyle(node),
          rect = node.getBoundingClientRect()
        return {
          tag: node.tagName,
          component: node.getAttribute("data-component"),
          slot: node.getAttribute("data-slot"),
          className: node.className,
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          display: css.display,
          cssWidth: css.width,
          minWidth: css.minWidth,
          maxWidth: css.maxWidth,
          flex: css.flex,
          contentVisibility: css.contentVisibility,
          contain: css.contain,
          overflow: css.overflow,
          whiteSpace: css.whiteSpace,
        }
      }
      return {
        viewport: innerWidth,
        group: describe(element),
        parts: [...element.querySelectorAll('[data-component="tool-part-wrapper"]')].map((part) => {
          const title = part.querySelector('[data-slot="basic-tool-tool-title"]')
          const range = document.createRange()
          range.selectNodeContents(title)
          const chain = []
          for (let node = title; node && node !== element; node = node.parentElement) chain.push(describe(node))
          return {
            text: title.textContent,
            rangeRects: [...range.getClientRects()].map((rect) => ({
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
            })),
            chain,
          }
        }),
      }
    })
    result.samples.push({ label, ...sample })
    await run.capture(label)
    await writeFile(join(record, "layout-progress.json"), JSON.stringify(result, null, 2))
  }
  await measure("baseline")
  if (process.argv.includes("--diagnose")) {
    for (const [label, css] of [
      [
        "visibility",
        '[data-component="process-tool-group"] [data-component="tool-trigger"] { content-visibility: visible !important; }',
      ],
      ["flex", '[data-component="process-tool-group"] [data-component="tool-trigger"] { flex: 1 1 0%; min-width: 0; }'],
      [
        "content-flex",
        '[data-component="process-tool-group"] [data-slot="basic-tool-tool-trigger-content"] { flex: 1 1 0%; }',
      ],
    ]) {
      const style = await page.addStyleTag({ content: css })
      await measure(label)
      await style.evaluate((element) => element.remove())
      await measure(label + "-reverted")
    }
  }
} catch (error) {
  result.failure = String(error)
  process.exitCode = 1
  await run.capture("layout-failure").catch(() => {})
} finally {
  try {
    await run.close()
  } catch (error) {
    result.closeError = String(error)
    process.exitCode = 1
  }
  result.closed = run.report.closed
  result.requests = observations
  await writeFile(join(record, "layout-result.json"), JSON.stringify(result, null, 2))
  console.log(
    JSON.stringify({
      samples: result.samples.length,
      closed: result.closed,
      failure: result.failure,
      closeError: result.closeError,
    }),
  )
}
