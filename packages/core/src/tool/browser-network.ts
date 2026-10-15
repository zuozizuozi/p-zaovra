export * as BrowserNetwork from "./browser-network"

import type { BrowserContext, Page } from "playwright-core"
import { BrowserStream } from "./browser-stream"

export const workerNotice =
  "Built-in browser disables Web Workers for security (dedicated, shared and service workers). 内置浏览器为安全起见禁用了 Worker。Use the system browser for full browser capabilities."

export async function install(context: BrowserContext, origins: Set<string>, log: (text: string) => void) {
  const streaming = new WeakSet<Page>()
  await context.addInitScript(() => {
    const denied = function () {
      throw new DOMException("Built-in browser disables Web Workers for security", "SecurityError")
    }
    for (const name of ["Worker", "SharedWorker"])
      Object.defineProperty(globalThis, name, { value: denied, writable: false, configurable: false })
    Object.defineProperty(Navigator.prototype, "serviceWorker", { value: undefined, configurable: false })
  })
  await context.route("**/*", async (route) => {
    // Chromium can resend even POST after an empty response without another
    // Fetch pause. Only read requests use its native transport; mutations keep
    // the explicit zero-retry, zero-redirect transport below.
    if (
      ["GET", "HEAD"].includes(route.request().method()) &&
      ["fetch", "xhr", "eventsource"].includes(route.request().resourceType()) &&
      streaming.has(route.request().frame().page())
    )
      return route.continue()
    const url = new URL(route.request().url())
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || !origins.has(url.origin)) {
      log(`Blocked origin: ${url.origin}`)
      return route.abort("blockedbyclient").catch(() => {})
    }
    const response = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: 10000 }).catch((error: Error) => {
      log(`Request failed; effects may be partial, no retry: ${error.message}`)
    })
    if (!response) return route.abort("failed").catch(() => {})
    try {
      if (response.status() >= 300 && response.status() < 400 && response.headers().location) {
        log(`Redirect blocked; explicitly open and authorize the destination: ${response.headers().location}`)
        await route.fulfill({
          status: 409,
          contentType: "text/plain",
          body: "Redirect blocked. Explicitly open the destination after authorization.",
        })
        return
      }
      const headers = response.headers()
      // A separate policy intersects with the site's policy; never replace it.
      headers["content-security-policy"] = [headers["content-security-policy"], "worker-src 'none'"]
        .filter(Boolean)
        .join(", ")
      await route.fulfill({ response, headers })
    } catch (error) {
      log(`Response delivery failed; no retry: ${String(error)}`)
    } finally {
      await response.dispose()
    }
  })
  await context.routeWebSocket("**/*", (socket) => {
    const url = new URL(socket.url())
    const valid = ["ws:", "wss:"].includes(url.protocol) && !url.username && !url.password
    url.protocol = url.protocol === "wss:" ? "https:" : "http:"
    if (valid && origins.has(url.origin)) {
      socket.connectToServer()
      return
    }
    log(`Blocked WebSocket origin: ${url.origin}`)
    socket.close()
  })
  return {
    stream: async (page: Page) => {
      await BrowserStream.install(page, origins, log)
      streaming.add(page)
    },
  }
}
