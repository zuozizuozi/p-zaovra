export * as BrowserStream from "./browser-stream"

import type { Page } from "playwright-core"

type Message = { id?: number; error?: { message: string }; method?: string; params?: Record<string, unknown> }

/** Page and OOPIF interception; Worker execution is independently denied by BrowserNetwork. */
export async function install(page: Page, origins: Set<string>, log: (text: string) => void) {
  const session = await page.context().newCDPSession(page)
  const browser = page.context().browser()!
  const pending = new Set<(error: Error) => void>()
  const fail = (error: unknown) => {
    log(`Streaming authorization failed closed: ${String(error)}`)
    void browser.close().catch(() => {})
  }
  browser.on("disconnected", () => {
    pending.forEach((reject) => reject(new Error("Browser closed")))
    pending.clear()
  })
  const create = (transport: (message: string) => Promise<unknown>) => {
    let sequence = 0
    const calls = new Map<number, { resolve: () => void; reject: (error: Error) => void }>()
    const children = new Map<string, ReturnType<typeof create>>()
    const chains = new Map<string, { count: number; method: string }>()
    const requests = new Map<string, string>()
    const send = (method: string, params: Record<string, unknown> = {}): Promise<void> =>
      new Promise((resolve, reject) => {
        const id = ++sequence
        calls.set(id, { resolve, reject })
        pending.add(reject)
        transport(JSON.stringify({ id, method, params })).catch(reject)
      })
    const ready = async () => {
      await send("Network.enable")
      await send("Fetch.enable", {
        patterns: [
          { urlPattern: "*", requestStage: "Request" },
          { urlPattern: "*", resourceType: "Document", requestStage: "Response" },
        ],
      })
      await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: false })
    }
    const receive = (message: Message): void => {
      if (message.id) {
        const call = calls.get(message.id)
        if (!call) return
        calls.delete(message.id)
        pending.delete(call.reject)
        if (message.error) call.reject(new Error(message.error.message))
        else call.resolve()
        return
      }
      const params = message.params ?? {}
      if (message.method === "Network.loadingFinished" || message.method === "Network.loadingFailed") {
        const id = requests.get(String(params.requestId))
        if (id) chains.delete(id)
        requests.delete(String(params.requestId))
        return
      }
      if (message.method === "Target.receivedMessageFromTarget") {
        children.get(String(params.sessionId))?.receive(JSON.parse(String(params.message)))
        return
      }
      if (message.method === "Target.detachedFromTarget") {
        children.delete(String(params.sessionId))
        return
      }
      if (message.method === "Target.attachedToTarget") {
        const info = params.targetInfo as { type: string }
        if (info.type !== "iframe" || !params.waitingForDebugger) {
          fail(new Error(`Unsupported unguarded target: ${info.type}`))
          return
        }
        const child = create((message) => send("Target.sendMessageToTarget", { sessionId: params.sessionId, message }))
        children.set(String(params.sessionId), child)
        void child
          .ready()
          .then(async () => {
            log("Streaming iframe guard installed before execution")
            await child.send("Runtime.runIfWaitingForDebugger")
          })
          .catch(fail)
        return
      }
      if (message.method !== "Fetch.requestPaused") return
      void (async () => {
        if (params.responseStatusCode) {
          const headers = params.responseHeaders as { name: string; value: string }[]
          await send("Fetch.continueResponse", {
            requestId: params.requestId,
            responseCode: params.responseStatusCode,
            responsePhrase: params.responseStatusText,
            responseHeaders: [...headers, { name: "Content-Security-Policy", value: "worker-src 'none'" }],
          })
          return
        }
        if (params.responseErrorReason) {
          await send("Fetch.continueRequest", { requestId: params.requestId })
          return
        }
        const request = params.request as { url: string; method: string }
        const url = new URL(request.url)
        // Cross-origin redirects can start a new Fetch id without its optional
        // redirectedRequestId. Network id remains the chain's stable identity.
        const previousID = params.redirectedRequestId ?? requests.get(String(params.networkId))
        const previous = chains.get(String(previousID))
        const count = previous ? previous.count + 1 : 0
        const allowed =
          ["http:", "https:"].includes(url.protocol) &&
          !url.username &&
          !url.password &&
          origins.has(url.origin) &&
          count <= 8 &&
          (!previous || ["GET", "HEAD"].includes(previous.method))
        chains.set(String(params.requestId), { count, method: request.method })
        if (params.networkId) requests.set(String(params.networkId), String(params.requestId))
        if (previousID) chains.delete(String(previousID))
        if (!allowed) log(`Blocked request or redirect: ${url.origin}`)
        await send(allowed ? "Fetch.continueRequest" : "Fetch.failRequest", {
          requestId: params.requestId,
          ...(!allowed ? { errorReason: "BlockedByClient" } : {}),
        })
      })().catch(fail)
    }
    return { send, ready, receive }
  }
  const primary = create(async (message) => {
    const command = JSON.parse(message)
    await session.send(command.method, command.params)
    primary.receive({ id: command.id })
  })
  session.on("Target.receivedMessageFromTarget", (params) =>
    primary.receive({ method: "Target.receivedMessageFromTarget", params }),
  )
  session.on("Target.attachedToTarget", (params) => primary.receive({ method: "Target.attachedToTarget", params }))
  session.on("Target.detachedFromTarget", (params) => primary.receive({ method: "Target.detachedFromTarget", params }))
  session.on("Fetch.requestPaused", (params) => primary.receive({ method: "Fetch.requestPaused", params }))
  session.on("Network.loadingFinished", (params) => primary.receive({ method: "Network.loadingFinished", params }))
  session.on("Network.loadingFailed", (params) => primary.receive({ method: "Network.loadingFailed", params }))
  await primary.ready()
}
