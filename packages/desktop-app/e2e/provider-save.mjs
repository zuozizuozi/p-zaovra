import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { mainPath } from "./main-path.mjs"

// New-profile ordinary Electron regression; uses only mainPath's loopback provider.
export async function providerSave(options) {
  const run = await mainPath({
    ...options,
    launchArgs: [options.application ?? dirname(dirname(fileURLToPath(import.meta.url)))],
    packaged: false,
  })
  await run.desktop.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().forEach((window) => window.webContents.setBackgroundThrottling(false)),
  )
  const requests = []
  const roots = []
  const note = (type, request, extra = {}) => {
    const url = new URL(request.url())
    if (!url.protocol.startsWith("http")) return
    requests.push({ at: new Date().toISOString(), type, method: request.method(), url: url.href, ...extra })
    if (type !== "start") return
    // This harness opens a fresh, non-Git Documents folder, never a filesystem root.
    const directory = url.searchParams.get("location[directory]") ?? url.searchParams.get("directory")
    if (directory === "/" || /^[a-z]:[\\/]?$/i.test(directory ?? "")) roots.push(url.href)
  }
  run.page.on("request", (request) => note("start", request))
  run.page.on("response", (response) => note("response", response.request(), { status: response.status() }))
  run.page.on("requestfailed", (request) => note("failed", request, { error: request.failure()?.errorText }))
  try {
    await run.fresh()
    await run.connect()
    assert.deepEqual(roots, [], "non-Git draft must not bootstrap global metadata's filesystem root")
  } finally {
    await writeFile(join(options.record, "provider-save-network.json"), JSON.stringify({ roots, requests }, null, 2))
    await run.close()
  }
}
