import { afterEach, expect, mock, test } from "bun:test"
import { render } from "solid-js/web"
import { MemoryRouter, Route } from "@solidjs/router"
import { createSignal } from "solid-js"
import type { MemoryAutomaticPreference, MemoryTidyTask } from "@zaovra-ai/sdk/v2/client"
import { createZaovraClient } from "@zaovra-ai/sdk/v2/client"
import { DialogProvider } from "@zaovra-ai/ui/context/dialog"
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
mock.module("@/context/server-sdk", () => ({ useServerSDK: () => () => ({ scope: "tidy-test", client }) }))
mock.module("@/context/server-sync", () => ({
  useServerSync: () => () => ({ data: { config: {} }, session: { lineage: { peek: () => undefined } } }),
}))
const { SettingsMemoryV2 } = await import("../../src/components/settings-v2/memory")
let dispose: (() => void) | undefined
const calls: { path: string; body: Record<string, unknown> }[] = []
let failure: "prepare" | "start" | "automatic" | undefined
let automatic: MemoryAutomaticPreference | null = null
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
  automatic = null
  calls.length = 0
  localWrites = 0
  client = createZaovraClient({
    baseUrl: "http://tidy.invalid",
    throwOnError: true,
    fetch: async (request) => {
      const path = new URL(request.url).pathname
      if (request.method === "GET" && path === "/api/memory/automatic") return Response.json({ data: automatic })
      if (request.method === "GET" && path === "/api/memory/pages") return Response.json({ data: [] })
      if (request.method === "GET" && path === "/api/memory/recovery")
        return Response.json({
          data: {
            scope: "test",
            directory: "/tidy-project",
            frozen: false,
            automaticFrozen: false,
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
      calls.push({ path, body })
      if (hold) await hold
      if (path === "/api/memory/automatic") {
        const input = body as {
          requestID: string
          model: MemoryAutomaticPreference["model"]
          tokens: number
          dailyTokens: number
        }
        automatic = {
          directory: "/tidy-project",
          generation: input.requestID,
          model: input.model,
          tokens: input.tokens,
          dailyTokens: input.dailyTokens,
          enabled: true,
          currentRun: null,
          confirmedAt: 1,
        }
        if (failure === "automatic") {
          failure = undefined
          return Response.json({ message: "Lost response" }, { status: 503 })
        }
        return Response.json({ data: automatic })
      }
      if (path === "/api/memory/automatic/disable") {
        automatic = { ...automatic!, enabled: false }
        return Response.json({ data: automatic })
      }
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
  })
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
})

test("automatic consent has a separate confirmation, idempotent retry and an explicit disable", async () => {
  await mount()
  await choose()
  await until(() => !button("Review automatic project tidy").disabled)
  button("Review automatic project tidy").click()
  expect(calls).toHaveLength(0)
  expect(document.querySelector('[data-slot="memory-tidy-confirm"]')?.textContent).toContain(
    "even when you are not chatting",
  )
  failure = "automatic"
  button("Confirm and enable automatic tidy").click()
  await until(
    () => document.querySelector('[role="alert"]') !== null && button("Retry this confirmation")?.disabled === false,
  )
  expect(calls).toHaveLength(1)
  const confirmed = calls[0].body
  button("Retry this confirmation").click()
  await until(() => button("Disable automatic tidy and stop its task")?.disabled === false)
  expect(calls.map((call) => call.path)).toEqual(["/api/memory/automatic", "/api/memory/automatic"])
  expect(calls[1].body).toEqual(confirmed)
  expect(confirmed).toMatchObject({
    model: { id: "chat-b", providerID: "configured" },
    tokens: 200000,
    dailyTokens: 1000000,
  })
  button("Disable automatic tidy and stop its task").click()
  await until(() => calls.length === 3 && button("Review automatic project tidy") !== undefined)
  expect(calls[2]).toEqual({ path: "/api/memory/automatic/disable", body: { expected: confirmed.requestID } })
  expect(tasks).toEqual([])
  expect(localWrites).toBe(0)
})

test("chosen model and explicit confirmation use the budgeted SDK without changing the current chat", async () => {
  await mount()
  expect(action().disabled).toBe(true)
  expect(calls).toHaveLength(0)
  await choose()
  await until(() => !action().disabled)
  action().click()
  expect(calls).toHaveLength(0)
  expect(document.querySelector('[data-slot="memory-tidy-confirm"]')?.textContent).toContain("200000 / 1000000")
  button("Confirm and start").click()
  await until(() => button("Cancel task") !== undefined)
  expect(calls[0].body).toMatchObject({
    layer: "project",
    tokens: 200000,
    dailyTokens: 1000000,
    model: { id: "chat-b", providerID: "configured" },
  })
  expect(calls.map((call) => call.path)).toEqual(["/api/memory/tidy", `/api/memory/tidy/${tasks[0].id}/start`])
  expect(localWrites).toBe(0)
  expect(action().disabled).toBe(true)
})

test("backing out of confirmation spends nothing and invalid budgets cannot be confirmed", async () => {
  await mount()
  await choose()
  await until(() => !action().disabled)
  action().click()
  button("Cancel").click()
  expect(calls).toHaveLength(0)
  const input = document.querySelector<HTMLInputElement>('[data-slot="memory-tidy"] input[type="number"]')!
  input.value = "0"
  input.dispatchEvent(new Event("input", { bubbles: true }))
  expect(action().disabled).toBe(true)
})

for (const stage of ["prepare", "start"] as const)
  test(`lost ${stage} response retries one confirmed identity and prevents double clicks`, async () => {
    await mount()
    await choose()
    await until(() => !action().disabled)
    action().click()
    failure = stage
    const gate = Promise.withResolvers<void>()
    hold = gate.promise
    button("Confirm and start").click()
    await until(() => calls.length === 1)
    expect(button("Retry this confirmation").disabled).toBe(true)
    button("Retry this confirmation").click()
    expect(calls).toHaveLength(1)
    hold = undefined
    gate.resolve()
    await until(() => document.querySelector('[role="alert"]') !== null && !button("Retry this confirmation").disabled)
    expect(picker().disabled).toBe(true)
    button("Retry this confirmation").click()
    await until(() => action() !== undefined)
    expect(tasks).toHaveLength(1)
    const prepares = calls.filter((call) => call.path === "/api/memory/tidy")
    expect(prepares).toHaveLength(2)
    expect(new Set(prepares.map((call) => JSON.stringify(call.body))).size).toBe(1)
    expect(calls.filter((call) => call.path.endsWith("/start"))).toHaveLength(stage === "start" ? 2 : 1)
    expect(localWrites).toBe(0)
  })

test("reopening a paused task reads without spending and cancellation retains unknown usage", async () => {
  await mount([
    {
      id: "tidy-existing",
      requestID: "old",
      sessionID: "session-tidy",
      layer: "project",
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
  await until(() => button("Start / continue") !== undefined)
  expect(calls).toHaveLength(0)
  expect(document.body.textContent).toContain("Unconfirmed reservations retained: 100")
  button("Cancel task").click()
  await until(() => document.body.textContent?.includes("Cancelled") === true)
  expect(calls.map((call) => call.path)).toEqual(["/api/memory/tidy/tidy-existing/cancel"])
  expect(document.body.textContent).toContain("110 / 200000")
})

test("changing the project invalidates an unsubmitted confirmation", async () => {
  await mount()
  await choose()
  await until(() => !action().disabled)
  action().click()
  target!("/different-project")
  await until(() => !document.querySelector('[data-slot="memory-tidy-confirm"]'))
  expect(action().disabled).toBe(true)
  expect(calls).toHaveLength(0)
})
