import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import { resolve, join } from "node:path"
import { pathToFileURL } from "node:url"

export async function timelineRegression(options) {
  assert.match(options.source, /^[0-9a-f]{40}$/, "exact source identity")
  const { timelineFollow } = await import("./timeline-follow.mjs")
  const { timelineScroll } = await import("./timeline-scroll.mjs")
  const { timelineEntries } = await import("./timeline-entries.mjs")
  await mkdir(options.record, { recursive: true })
  const cases = []
  try {
    for (const [name, run] of [
      ["turns", timelineFollow],
      ["scroll", timelineScroll],
      ["entries", timelineEntries],
    ]) {
      await run({
        ...options,
        record: join(options.record, name),
        phase: "timeline-" + name,
        verify: true,
        resumeFollow: true,
        waitWarmup: true,
        onRuntime: async (instance) => {
          instance.report.benchmarkControls = { backgroundThrottling: false, testWindowOnly: true }
          await instance.desktop.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows().forEach((win) => win.webContents.setBackgroundThrottling(false)),
          )
          await options.onRuntime?.(instance)
        },
        onResult: async (value) => {
          cases.push({ name, ...value })
          await writeFile(join(options.record, name + ".json"), JSON.stringify(value, null, 2) + "\n")
        },
      })
    }
  } finally {
    await writeFile(
      join(options.record, "timeline.json"),
      JSON.stringify({ source: options.source, paidModelCalls: 0, cases }, null, 2) + "\n",
    )
  }
  assert.equal(cases.length, 3, "all timeline cases completed")
  assert(
    cases.every((value) => value.ok && value.run.closed && !value.closeError),
    "timeline acceptance and cleanup",
  )
  return cases
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] === "--help") {
    console.log(
      "node e2e/timeline-regression.mjs <electron-or-packaged-exe> <fresh-record-directory> <source-sha> [--ordinary <desktop-package-directory>]",
    )
  } else {
    assert(process.argv[2] && process.argv[3], "executable and fresh records required")
    assert(!process.argv[5] || process.argv[5] === "--ordinary", "unknown option")
    if (process.argv[5]) assert(process.argv[6], "ordinary desktop package directory required")
    await timelineRegression({
      executable: process.argv[2],
      record: resolve(process.argv[3]),
      source: process.argv[4],
      ...(process.argv[5] ? { launchArgs: [resolve(process.argv[6])], packaged: false } : {}),
    })
  }
}
