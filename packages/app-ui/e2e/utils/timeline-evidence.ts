import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { join, relative, resolve, isAbsolute } from "node:path"
import { test, type Browser, type Page, type TestInfo } from "@playwright/test"

export function registerTimelineEvidence() {
  if (!process.env.ZAOVRA_E2E_EVIDENCE_DIR) return
  test.beforeEach(async ({ browser }, info) => {
    await captureOwnership(browser, info)
  })
  test.beforeEach(async ({ page }, info) => {
    const requests: { method: string; path: string; bytes: number }[] = []
    const errors: string[] = []
    page.on("request", (request) =>
      requests.push({
        method: request.method(),
        path: new URL(request.url()).pathname,
        bytes: Buffer.byteLength(request.postData() ?? ""),
      }),
    )
    page.on("pageerror", (error) => errors.push(String(error)))
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url())
      const origin = new URL(info.project.use.baseURL!).origin
      if (url.origin === origin || ["data:", "blob:", "about:"].includes(url.protocol)) {
        await route.continue()
        return
      }
      await appendFile(
        info.outputPath("blocked-external.jsonl"),
        JSON.stringify({ origin: url.origin, path: url.pathname }) + "\n",
      )
      await route.abort("blockedbyclient")
    })
    await writeFile(
      info.outputPath("browser-start.json"),
      JSON.stringify(
        { testId: info.testId, workerPid: process.pid, title: info.title, started: new Date().toISOString() },
        null,
        2,
      ),
    )
    info.annotations.push({
      type: "owned-fixture",
      description: "new browser CDP identities held by the phase recorder; no ordinary profile",
    })
    evidence.set(info.testId, { page, requests, errors })
  })
  test.afterEach(async ({ browser }, info) => {
    await captureOwnership(browser, info)
    const saved = evidence.get(info.testId)
    if (!saved) {
      await writeFile(
        info.outputPath("page-setup-incomplete.json"),
        JSON.stringify({ testId: info.testId, status: info.status }),
      )
      return
    }
    const page = saved.page
    const snapshot = await page.evaluate(() => {
      const wire = (window as Window & { __testSseTransport?: { command: (input: { type: string }) => unknown } })
        .__testSseTransport
      const probe = (window as Window & { __visualStabilityProbe?: unknown }).__visualStabilityProbe
      return {
        parts: [...document.querySelectorAll("[data-timeline-part-id]")].map((node) => ({
          id: node.getAttribute("data-timeline-part-id"),
          row: node.closest("[data-timeline-row]")?.getAttribute("data-timeline-row"),
          messageID: node.closest("[data-message-id]")?.getAttribute("data-message-id"),
          text: node.textContent,
          rect: node.getBoundingClientRect().toJSON(),
        })),
        acknowledgements: wire?.command({ type: "acknowledgements" }),
        visualProbe: probe
          ? JSON.parse(JSON.stringify(probe, (_key, value) => (value instanceof Node ? undefined : value)))
          : null,
      }
    })
    await writeFile(
      info.outputPath("event-dom-evidence.json"),
      JSON.stringify(
        {
          testId: info.testId,
          title: info.title,
          status: info.status,
          diagnostics: { requests: saved.requests, errors: saved.errors },
          snapshot,
        },
        null,
        2,
      ),
    )
    if (info.status !== "passed") await writeFile(info.outputPath("failure-complete.html"), await page.content())
    evidence.delete(info.testId)
  })
}

const evidence = new Map<
  string,
  { page: Page; requests: { method: string; path: string; bytes: number }[]; errors: string[] }
>()

export async function recordTimelineDelivery(event: unknown, acknowledgement: unknown) {
  if (!process.env.ZAOVRA_E2E_EVIDENCE_DIR) return
  const info = test.info()
  await appendFile(
    info.outputPath("timeline-deliveries.jsonl"),
    JSON.stringify({ at: new Date().toISOString(), event, acknowledgement }) + "\n",
  )
}

async function captureOwnership(browser: Browser, info: TestInfo) {
  const folder = resolve(process.env.ZAOVRA_E2E_EVIDENCE_DIR!)
  const output = relative(folder, info.outputPath("event-dom-evidence.json"))
  if (output.startsWith("..") || isAbsolute(output)) throw new Error("Evidence output escaped the phase")
  await mkdir(info.outputDir, { recursive: true })
  const session = await browser.newBrowserCDPSession()
  const values = await session.send("SystemInfo.getProcessInfo")
  await session.detach()
  const ownership = join(folder, "ownership")
  await mkdir(ownership, { recursive: true })
  const file = join(ownership, "processes-" + process.pid + "-" + Date.now() + ".json")
  await writeFile(
    file,
    JSON.stringify(
      values.processInfo.map((item) => ({ pid: item.id, type: item.type })),
      null,
      2,
    ),
    { flag: "wx" },
  )
  const until = Date.now() + 10000
  while (true) {
    const found = await readFile(file.replace(".json", "-ack.json")).catch(() => null)
    if (found) return
    if (Date.now() >= until) throw new Error("Browser live-identity recorder did not acknowledge")
    await new Promise((done) => setTimeout(done, 25))
  }
}
