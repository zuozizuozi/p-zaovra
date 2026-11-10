import { afterAll, expect, mock, test } from "bun:test"
import { createServer } from "node:http"
import { Suspense } from "solid-js"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import { createZaovraClient } from "@zaovra-ai/sdk/v2/client"

const [state, setState] = createStore({ id: "ses_808", server: 0 })
const requests: {
  sessionID: string | null
  response: ReturnType<typeof Promise.withResolvers<{ total: number; status: number }>>
}[] = []
const server = createServer((request, response) => {
  if (request.method === "OPTIONS") {
    response.setHeader("Access-Control-Allow-Origin", "*")
    response.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS")
    response.setHeader("Access-Control-Allow-Headers", "*")
    response.writeHead(204).end()
    return
  }
  const pending = Promise.withResolvers<{ total: number; status: number }>()
  requests.push({
    sessionID: new URL(request.url!, "http://127.0.0.1").searchParams.get("sessionID"),
    response: pending,
  })
  void pending.promise.then(({ total, status }) => {
    response.statusCode = status
    response.setHeader("Content-Type", "application/json")
    response.setHeader("Access-Control-Allow-Origin", "*")
    response.end(JSON.stringify(status === 200 ? { data: summary(total) } : { message: "Unavailable" }))
  })
})
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
const address = server.address()
if (!address || typeof address === "string") throw new Error("Missing local usage server address")
const listeners = new Set<(event: { details: unknown }) => void>()
const clients = [0, 1].map(() => ({
  client: createZaovraClient({ baseUrl: `http://127.0.0.1:${address.port}`, throwOnError: true }),
  event: {
    listen(listener: (event: { details: unknown }) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  },
}))
const sync = { data: { config: {} }, session: { watchExecution: async () => {} } }
mock.module("@solidjs/router", () => ({ useParams: () => state }))
mock.module("@/context/server-sdk", () => ({ useServerSDK: () => () => clients[state.server] }))
mock.module("@/context/server-sync", () => ({ useServerSync: () => () => sync }))
mock.module("@/context/language", () => ({ useLanguage: () => ({ t: (key: string) => key }) }))
mock.module("@/components/settings-dialog", () => ({ useSettingsDialog: () => () => {} }))
const { SessionUsageBar } = await import("../../src/components/usage-dashboard")

const totals = (total: number) => ({
  input: total,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total,
  calls: total ? 1 : 0,
  unreported: 0,
})
const summary = (total: number) => ({
  total: totals(total),
  own: totals(total),
  official: totals(0),
  unknown: totals(0),
  lastTurn: totals(total),
  models: [],
  updatedAt: 1,
  billing: "unavailable",
})
const respond = (request: (typeof requests)[number], total: number, status = 200) =>
  request.response.resolve({ total, status })
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
const next = async (index: number) => {
  for (let count = 0; !requests[index] && count < 100; count++) await settle()
  expect(requests[index]).toBeDefined()
  return requests[index]
}
const visible = async (root: HTMLElement, value: string) => {
  for (let count = 0; !root.textContent?.includes(value) && count < 100; count++) await settle()
  expect(root.textContent).toContain(value)
}
const mount = () => {
  const root = document.createElement("div")
  document.body.append(root)
  const dispose = render(
    () => (
      <Suspense fallback={<span>Loading composer</span>}>
        <div data-fixture="composer">
          <SessionUsageBar />
        </div>
      </Suspense>
    ),
    root,
  )
  return {
    root,
    dispose: () => {
      dispose()
      root.remove()
    },
  }
}
afterAll(() => {
  for (const request of requests) respond(request, 0)
  server.closeAllConnections()
  server.close()
})

test("808 current usage retains its trigger and value through focus and idle refreshes", async () => {
  const index = requests.length
  setState({ id: "ses_808", server: 0 })
  const view = mount()
  try {
    respond(await next(index), 100)
    await visible(view.root, "100 Tokens")
    const bar = view.root.querySelector(".session-usage-bar")
    window.dispatchEvent(new Event("focus"))
    const refresh = await next(index + 1)
    expect(refresh.sessionID).toBe("ses_808")
    expect(view.root.querySelector(".session-usage-bar")).toBe(bar)
    expect(bar?.isConnected).toBe(true)
    expect(bar?.textContent).toContain("100 Tokens")
    respond(refresh, 250)
    await visible(view.root, "250 Tokens")
    for (const listener of listeners)
      listener({ details: { type: "session.status", properties: { sessionID: "ses_808", status: { type: "idle" } } } })
    const idle = await next(index + 2)
    expect(view.root.querySelector(".session-usage-bar")).toBe(bar)
    expect(bar?.textContent).toContain("250 Tokens")
    respond(idle, 310)
    await visible(view.root, "310 Tokens")
    expect(view.root.querySelector(".session-usage-bar")).toBe(bar)
  } finally {
    view.dispose()
  }
  expect(listeners.size).toBe(0)
})

test("808 loading without usage adds no row and never leaks prior session or server usage", async () => {
  const index = requests.length
  setState({ id: "ses_empty808", server: 0 })
  const view = mount()
  try {
    const initial = await next(index)
    expect(view.root.querySelector('[data-fixture="composer"]')).not.toBeNull()
    expect(view.root.querySelector(".session-usage-bar")).toBeNull()
    respond(initial, 0)
    await settle()
    expect(view.root.querySelector(".session-usage-bar")).toBeNull()
    window.dispatchEvent(new Event("focus"))
    const first = await next(index + 1)
    expect(view.root.querySelector(".session-usage-bar")).toBeNull()
    respond(first, 9)
    await visible(view.root, "9 Tokens")
    setState("id", "ses_other808")
    const other = await next(index + 2)
    expect(other.sessionID).toBe("ses_other808")
    expect(view.root.querySelector(".session-usage-bar")).toBeNull()
    respond(other, 22)
    await visible(view.root, "22 Tokens")
    setState("server", 1)
    const changed = await next(index + 3)
    expect(view.root.querySelector(".session-usage-bar")).toBeNull()
    respond(changed, 33)
    await visible(view.root, "33 Tokens")
    setState("id", "")
    await settle()
    expect(view.root.querySelector(".session-usage-bar")).toBeNull()
    expect(requests.length).toBe(index + 4)
  } finally {
    view.dispose()
  }
  expect(listeners.size).toBe(0)
})

test("808 refresh errors preserve a visible row and recover on the next refresh", async () => {
  const index = requests.length
  setState({ id: "ses_error808", server: 0 })
  const view = mount()
  try {
    respond(await next(index), 71)
    await visible(view.root, "71 Tokens")
    const bar = view.root.querySelector(".session-usage-bar")
    window.dispatchEvent(new Event("focus"))
    const failing = await next(index + 1)
    expect(view.root.querySelector(".session-usage-bar")).toBe(bar)
    respond(failing, 0, 503)
    await visible(view.root, "usage.error")
    expect(view.root.querySelector(".session-usage-bar")).toBe(bar)
    window.dispatchEvent(new Event("focus"))
    const retry = await next(index + 2)
    expect(view.root.querySelector(".session-usage-bar")).toBe(bar)
    respond(retry, 82)
    await visible(view.root, "82 Tokens")
  } finally {
    view.dispose()
  }
  expect(listeners.size).toBe(0)
})
