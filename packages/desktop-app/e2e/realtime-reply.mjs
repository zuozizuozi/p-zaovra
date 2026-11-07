import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { mainPath } from "./main-path.mjs"

// Reproduce the first reply immediately after saving a service in a fresh profile.
// The provider holds the stream open until the real renderer shows its text.
export async function realtimeReply(options) {
  const run = await mainPath(options)
  const timings = []
  try {
    await options.onRuntime?.(run)
    await run.fresh()
    await run.connect()
    const first = Date.now()
    await run.reply()
    await footer(run, "718-first-footer")
    timings.push({ case: "fresh-service-first-reply", ms: Date.now() - first })

    run.control.stream = Promise.withResolvers()
    const input = run.page.locator('[data-component="prompt-input"][contenteditable="true"]')
    const second = Date.now()
    await input.fill("MP4：在同一会话再次回复一句话")
    await input.press("Enter")
    await run.page.getByText("实时回复已到达", { exact: true }).nth(1).waitFor({ state: "visible", timeout: 30000 })
    const visibleMs = Date.now() - second
    assert(visibleMs < 30000, "second reply is visible before completion without reload")
    await run.page.getByRole("button", { name: /^(停止|Stop)$/ }).waitFor({ state: "visible" })
    await run.capture("718-second-streaming")
    run.control.stream.resolve()
    await run.page.getByRole("button", { name: /^(停止|Stop)$/ }).waitFor({ state: "hidden" })
    await run.page
      .getByText(/Build · mp-returned/)
      .last()
      .waitFor({ state: "visible" })
    await footer(run, "718-second-footer")
    timings.push({ case: "same-session-second-reply", visibleMs, ms: Date.now() - second })

    await run.page.getByRole("button", { name: "新对话", exact: true }).last().click()
    await run.page.getByText("实时回复已到达", { exact: true }).first().waitFor({ state: "hidden" })
    await input.waitFor({ state: "visible" })
    run.control.stream = Promise.withResolvers()
    const third = Date.now()
    await run.reply()
    await footer(run, "718-third-footer")
    timings.push({ case: "saved-service-new-session", ms: Date.now() - third })
    assert.equal(run.report.providerError, undefined)
    assert.equal(run.report.paidModelCalls, 0)
    await run.capture("718-final")
    run.report.realtimeReply = { timings, noReload: true, sameSessionSecondReply: true }
    return run
  } finally {
    await run.close()
    await writeFile(
      join(resolve(options.record), "realtime-reply.json"),
      JSON.stringify({ timings, closed: run.report.closed }, null, 2) + "\n",
    )
  }
}

async function footer(run, label) {
  await run.page.mouse.move(10, 10)
  const visible = await run.page
    .getByText(/Build · mp-returned/)
    .last()
    .evaluate((element) => {
      const rect = element.getBoundingClientRect()
      if (
        !rect.width ||
        !rect.height ||
        rect.x < 0 ||
        rect.right > innerWidth ||
        rect.y < 0 ||
        rect.bottom > innerHeight
      )
        return false
      for (let current = element; current; current = current.parentElement) {
        const style = getComputedStyle(current)
        if (style.display === "none" || style.visibility !== "visible" || Number(style.opacity) < 0.99) return false
      }
      return true
    })
  assert(visible, "actual returned model footer is perceptible without hover")
  await run.page.waitForFunction(
    () => {
      const meta = [...document.querySelectorAll('[data-slot="text-part-meta"]')]
        .filter((el) => el.getClientRects().length)
        .at(-1)
      const action = meta?.parentElement?.firstElementChild
      return action && action !== meta && getComputedStyle(action).opacity === "0"
    },
    undefined,
    { timeout: 2000 },
  )
  await run.capture(label)
}

if (
  typeof process !== "undefined" &&
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await realtimeReply({ executable: process.argv[2], record: process.argv[3], source: process.env.ZAOVRA_SOURCE_SHA })
}
