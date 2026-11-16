import { afterEach, expect, mock, test } from "bun:test"
import { render } from "solid-js/web"
import { createSignal } from "solid-js"
import type { MemoryTidyTask } from "@zaovra-ai/sdk/v2/client"
import { createZaovraClient } from "@zaovra-ai/sdk/v2/client"
import { DialogProvider } from "@zaovra-ai/ui/context/dialog"
import { MemoryRouter, Route } from "@solidjs/router"
import { I18nProvider } from "@zaovra-ai/ui/context/i18n"
import { dict } from "../../src/i18n/en"

const language = { locale: () => "en", t: (key: string) => dict[key as keyof typeof dict] ?? key }
const items = [
  {
    id: "chat-b",
    baseModelID: "chat-b",
    name: "Configured chat",
    provider: { id: "configured", name: "Configured" },
    limit: { context: 10000 },
    variants: {},
  },
  {
    id: "embedding",
    baseModelID: "embedding",
    name: "Embedding only",
    provider: { id: "configured", name: "Configured" },
    limit: { context: 10000 },
    variants: {},
  },
]
let client: ReturnType<typeof createZaovraClient>
let localWrites = 0
let projectFrozen = false
const [serverScope, setServerScope] = createSignal("tidy-test")
let switchServer: (() => void) | undefined
mock.module("@/context/language", () => ({ useLanguage: () => language }))
mock.module("@/context/local", () => ({
  useLocal: () => {
    localWrites++
    throw new Error("Tidy must not touch conversation selection")
  },
}))
mock.module("@/context/models", () => ({
  useModels: () => ({
    list: () => items,
    visible: () => true,
    type: (key: { modelID: string }) => (key.modelID === "embedding" ? "embedding" : "chat"),
    catalog: { refresh: async () => {}, loading: () => false, error: () => undefined },
  }),
}))
mock.module("@/context/server-sdk", () => ({ useServerSDK: () => () => ({ scope: serverScope(), client }) }))
mock.module("@/context/server-sync", () => ({
  useServerSync: () => () => ({ data: { config: {} }, session: { lineage: { peek: () => undefined } } }),
}))
const { SettingsMemoryV2 } = await import("../../src/components/settings-v2/memory")
let dispose: (() => void) | undefined
const calls: { path: string; body: Record<string, unknown>; directory: string | null; server: string }[] = []
let failure: "prepare" | "start" | undefined
let tasks: MemoryTidyTask[] = []
let target: ((value: string) => void) | undefined
let hold: Promise<void> | undefined

async function until(check: () => boolean) {
  for (let i = 0; i < 150; i++) {
    if (check()) return
    await Bun.sleep(10)
  }
  throw new Error("DOM condition timed out: " + document.body.textContent?.slice(-700))
}
function button(text: string) {
  return [...document.querySelectorAll<HTMLButtonElement>('[data-slot="memory-tidy"] button')].find(
    (item) => item.textContent?.trim() === text,
  )!
}
function action() {
  return button("Review and confirm")
}
function picker() {
  return document.querySelector<HTMLButtonElement>('[aria-label="Model for this tidy"]')!
}
async function mount(initial: MemoryTidyTask[] = []) {
  tasks = initial
  calls.length = 0
  localWrites = 0
  const options = {
    baseUrl: "http://tidy.invalid",
    throwOnError: true,
    fetch: async (request: Request) => {
      const path = new URL(request.url).pathname
      if (request.method === "GET" && path === "/api/memory/automatic") return Response.json({ data: null })
      if (request.method === "GET" && path === "/api/memory/pages") return Response.json({ data: [] })
      if (request.method === "GET" && path === "/api/memory/recovery")
        return Response.json({
          data: {
            scope: "test",
            directory: "/tidy-project",
            frozen: projectFrozen,
            automaticFrozen: projectFrozen,
            state: "none",
            deleted: 0,
            notes: [],
          },
        })
      if (request.method === "GET" && path === "/api/memory")
        return Response.json({
          data: [
            {
              id: "note1",
              text: "Preference",
              status: "verified",
              kind: "preference",
              time: { observed: 1, created: 1, updated: 1 },
            },
          ],
        })
      const layer = new URL(request.url).searchParams.get("layer") ?? "project"
      if (request.method === "GET" && path === "/api/memory/tidy")
        return Response.json({ data: tasks.filter((task) => task.layer === layer) })
      const text = await request.text()
      const body = text ? (JSON.parse(text) as Record<string, unknown>) : {}
      calls.push({
        path,
        body,
        directory: new URL(request.url).searchParams.get("location[directory]"),
        server: new URL(request.url).host,
      })
      if (hold) await hold
      if (path === "/api/memory/tidy") {
        const request = body as {
          requestID: string
          layer: "project" | "user"
          model: { id: string; providerID: string }
          tokens: number
          dailyTokens: number
        }
        const task = tasks.find((item) => item.requestID === request.requestID) ?? {
          ...request,
          id: "tidy-" + request.requestID,
          sessionID: "session-tidy",
          directory: "/tidy-project",
          state: "active" as const,
          executing: false,
          usage: { known: 0, reserved: 0, charged: 0, unknown: 0 },
          time: { created: 1, finished: null },
        }
        if (!tasks.includes(task)) tasks.push(task)
        if (failure === "prepare") {
          failure = undefined
          return Response.json({ message: "Lost response" }, { status: 503 })
        }
        return Response.json({ data: task })
      }
      if (path.endsWith("/start") || path.endsWith("/cancel")) {
        const task = tasks.find((item) => path.includes(item.id))!
        if (path.endsWith("/start")) task.executing = true
        if (path.endsWith("/cancel")) {
          task.state = "cancelled"
          task.executing = false
        }
        if (failure === "start") {
          failure = undefined
          return Response.json({ message: "Lost response" }, { status: 503 })
        }
        return Response.json({ data: task })
      }
      throw new Error("Unexpected request " + path)
    },
  }
  client = createZaovraClient(options)
  switchServer = () => {
    client = createZaovraClient({ ...options, baseUrl: "http://new.invalid" })
    setServerScope("changed")
  }
  // HappyDOM has no CSS animations; make the computed no-animation state explicit for Kobalte presence.
  const css = document.createElement("style")
  css.textContent = "* { animation-name: none !important; }"
  document.body.append(css)
  const node = document.createElement("main")
  document.body.append(node)
  const [directory, setDirectory] = createSignal("/tidy-project")
  target = setDirectory
  dispose = render(
    () => (
      <I18nProvider value={language}>
        <DialogProvider>
          <MemoryRouter>
            <Route path="*" component={() => <SettingsMemoryV2 directory={directory()} />} />
          </MemoryRouter>
        </DialogProvider>
      </I18nProvider>
    ),
    node,
  )
  await until(() => !!action())
}
async function choose() {
  await until(() => !picker().disabled)
  picker().click()
  await until(() => !!document.querySelector('[data-option-key="configured:chat-b"]'))
  expect(document.querySelector('[data-option-key="configured:embedding"]')).toBeNull()
  expect(document.querySelector('[data-option-key="action:manage"]')).toBeNull()
  document.querySelector<HTMLButtonElement>('[data-option-key="configured:chat-b"]')!.click()
  await until(() => picker().textContent?.includes("Configured chat") === true)
}
afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.replaceChildren()
  failure = undefined
  hold = undefined
  projectFrozen = false
  setServerScope("tidy-test")
})

test("project recovery freeze leaves user scope available and cancellation preserves unknown", async () => {
  projectFrozen = true
  await mount([
    {
      id: "tidy-user",
      requestID: "user-old",
      sessionID: "session-user",
      layer: "user",
      directory: "/tidy-project",
      model: { id: "chat-b", providerID: "configured" },
      tokens: 200000,
      dailyTokens: 1000000,
      state: "active",
      executing: false,
      usage: { known: 10, reserved: 100, charged: 110, unknown: 1 },
      time: { created: 1, finished: null },
    },
  ])
  const scope = document.querySelector<HTMLSelectElement>('[data-slot="memory-tidy"] select')!
  expect(scope.closest("fieldset")?.disabled).toBe(false)
  expect(action().disabled).toBe(true)
  scope.value = "user"
  scope.dispatchEvent(new Event("change", { bubbles: true }))
  await until(() => !!button("Start / continue"))
  expect(button("Start / continue").disabled).toBe(false)
  button("Start / continue").click()
  await until(() => !button("Cancel task").disabled && !button("Start / continue"))
  expect(calls.map((x) => x.path)).toEqual(["/api/memory/tidy/tidy-user/start"])
  button("Cancel task").click()
  await until(() => document.body.textContent?.includes("Cancelled") === true)
  expect(document.body.textContent).toContain("Unconfirmed reservations retained: 100")
  expect(document.body.textContent).toContain("110 / 200000")
  await choose()
  await until(() => !action().disabled)
  action().click()
  expect(document.querySelector('[data-slot="memory-tidy-confirm"]')?.textContent).toContain(
    language.t("settings.memory.user.title"),
  )
  button("Cancel").click()
  scope.value = "project"
  scope.dispatchEvent(new Event("change", { bubbles: true }))
  expect(action().disabled).toBe(true)
  expect(calls).toHaveLength(2)
})
for (const change of ["directory", "server", "close"] as const)
  test(`confirmed in-flight prepare retains original identity and target on ${change}`, async () => {
    await mount()
    await choose()
    await until(() => !action().disabled)
    action().click()
    const gate = Promise.withResolvers<void>()
    hold = gate.promise
    button("Confirm and start").click()
    await until(() => calls.length === 1)
    const identity = calls[0].body.requestID
    if (change === "directory") target!("/different-project")
    if (change === "server") switchServer!()
    if (change === "close") {
      dispose?.()
      dispose = undefined
    }
    if (change !== "close") await until(() => !document.querySelector('[data-slot="memory-tidy-confirm"]'))
    hold = undefined
    gate.resolve()
    await until(() => calls.length === 2)
    expect(calls.map((x) => x.server)).toEqual(["tidy.invalid", "tidy.invalid"])
    expect(calls.map((x) => x.directory)).toEqual(["/tidy-project", "/tidy-project"])
    expect(calls[1].path).toBe(`/api/memory/tidy/tidy-${identity}/start`)
    expect(tasks).toHaveLength(1)
    expect(localWrites).toBe(0)
    expect(calls.filter((x) => x.path === "/api/memory/tidy")).toHaveLength(1)
  })
