import { afterEach, expect, mock, test } from "bun:test"
import { render } from "solid-js/web"
import { MemoryRouter, Route } from "@solidjs/router"
import { createSignal, ErrorBoundary } from "solid-js"
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
    api: { npm: "@ai-sdk/openai", url: "https://fixture.invalid/v1" },
    provider: { id: "configured", name: "Configured" },
    limit: { context: 10000 },
    variants: {},
  },
  {
    id: "chat-completions",
    baseModelID: "chat-completions",
    name: "Chat Completions",
    api: { npm: "@ai-sdk/openai-compatible", url: "https://fixture.invalid/v1" },
    provider: { id: "configured", name: "Configured" },
    limit: { context: 10000 },
    variants: {},
  },
  {
    id: "embedding",
    baseModelID: "embedding",
    name: "Embedding only",
    api: { npm: "@ai-sdk/openai", url: "https://fixture.invalid/v1" },
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
  useServerSync: () => () => ({
    data: { config: { memory: { enabled: true } } },
    session: { lineage: { peek: () => undefined } },
  }),
}))
const { SettingsMemoryV2 } = await import("../../src/components/settings-v2/memory")
let dispose: (() => void) | undefined
const calls: { path: string; body: Record<string, unknown>; query: URLSearchParams }[] = []
let failure: "prepare" | "start" | "automatic" | undefined
let automatic: MemoryAutomaticPreference | null = null
let tasks: MemoryTidyTask[] = []
let target: ((value: string) => void) | undefined
let hold: Promise<void> | undefined
let failedRead: "tidy" | "automatic" | undefined
let readFailures = 0
const renderErrors: unknown[] = []

async function until(check: () => boolean, attempts = 150) {
  for (let i = 0; i < attempts; i++) {
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
      const { pathname: path, searchParams: query } = new URL(request.url)
      if (request.method === "GET" && path === `/api/memory/${failedRead}`) {
        readFailures++
        return Response.json({ message: "Read unavailable" }, { status: 503 })
      }
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
      const layer = query.get("layer") ?? "project"
      if (request.method === "GET" && path === "/api/memory/tidy")
        return Response.json({ data: tasks.filter((task) => task.layer === layer) })
      const text = await request.text()
      const body = text ? (JSON.parse(text) as Record<string, unknown>) : {}
      calls.push({ path, body, query })
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
            <Route
              path="*"
              component={() => (
                <ErrorBoundary
                  fallback={(error) => {
                    renderErrors.push(error)
                    return <p data-slot="unexpected-boundary">Unexpected read error</p>
                  }}
                >
                  <SettingsMemoryV2 directory={directory()} />
                </ErrorBoundary>
              )}
            />
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
  expect(document.querySelector('[data-option-key="configured:chat-completions"]')).toBeNull()
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
  failedRead = undefined
  readFailures = 0
  renderErrors.length = 0
})

for (const resource of ["tidy", "automatic"] as const) {
  test(`initial ${resource} GET failure keeps refresh and blocks both spending confirmations`, async () => {
    failedRead = resource
    await mount()
    await choose()
    await until(() => readFailures > 0)
    expect(renderErrors).toEqual([])
    expect(document.querySelector('[data-slot="memory-tidy"] [role="alert"]')).not.toBeNull()
    expect(action().disabled).toBe(true)
    expect(button("Review automatic project tidy").disabled).toBe(true)
    expect(calls).toHaveLength(0)
    failedRead = undefined
    button(dict["settings.memory.task.refresh"]).click()
    await until(() => !action().disabled)
    expect(document.querySelector('[data-slot="memory-tidy"] [role="alert"]')).toBeNull()
    expect(calls).toHaveLength(0)
  })

  test(`running task ${resource} poll failure recovers and cancels without a duplicate submission`, async () => {
    await mount([
      {
        id: "tidy-poll",
        requestID: "poll",
        sessionID: "ses_poll",
        layer: "project",
        directory: "/tidy-project",
        model: { providerID: "configured", id: "chat-b" },
        tokens: 200000,
        dailyTokens: 1000000,
        state: "active",
        executing: true,
        usage: { known: 0, reserved: 90, charged: 90, unknown: 1 },
        time: { created: 1, finished: null },
      },
    ])
    await choose()
    failedRead = resource
    await until(() => readFailures > 0, 700)
    await Bun.sleep(20)
    expect(renderErrors).toEqual([])
    expect(action().disabled).toBe(true)
    expect(button("Review automatic project tidy").disabled).toBe(true)
    expect(calls).toHaveLength(0)
    failedRead = undefined
    button(dict["settings.memory.task.refresh"]).click()
    await until(
      () =>
        !!button(dict["settings.memory.task.stop"]) &&
        !document.querySelector('[data-slot="memory-tidy"] [role="alert"]'),
    )
    button(dict["settings.memory.task.stop"]).click()
    await until(() => tasks[0].state === "cancelled" && !button(dict["settings.memory.task.stop"]))
    expect(calls.map((call) => call.path)).toEqual(["/api/memory/tidy/tidy-poll/cancel"])
    expect(tasks[0].usage).toEqual({ known: 0, reserved: 90, charged: 90, unknown: 1 })
  }, 10000)
}

test("read failure during an unsubmitted confirmation cannot start it until refreshed", async () => {
  await mount()
  await choose()
  action().click()
  failedRead = "tidy"
  button(dict["settings.memory.task.refresh"]).click()
  await until(() => readFailures > 0)
  await Bun.sleep(20)
  expect(renderErrors).toEqual([])
  expect(button(dict["settings.memory.task.start"]).disabled).toBe(true)
  button(dict["settings.memory.task.start"]).click()
  expect(calls).toHaveLength(0)
  failedRead = undefined
  button(dict["settings.memory.task.refresh"]).click()
  await until(() => !button(dict["settings.memory.task.start"]).disabled)
  button(dict["settings.memory.task.start"]).click()
  await until(() => calls.length === 2 && !document.querySelector('[data-slot="memory-tidy-confirm"]'))
  expect(calls.filter((call) => call.path === "/api/memory/tidy")).toHaveLength(1)
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
  expect(calls[2].path).toBe("/api/memory/automatic/disable")
  expect(calls[2].body).toEqual({ expected: confirmed.requestID })
  expect(tasks).toEqual([])
  expect(localWrites).toBe(0)
})

test("lost automatic confirmation can be disabled without retrying its grant", async () => {
  await mount()
  await choose()
  await until(() => !button("Review automatic project tidy").disabled)
  button("Review automatic project tidy").click()
  failure = "automatic"
  button("Confirm and enable automatic tidy").click()
  await until(() => button("Retry this confirmation")?.disabled === false)
  expect(calls).toHaveLength(1)
  const confirmed = calls[0].body
  expect(button("Disable automatic tidy and stop its task").disabled).toBe(false)
  button("Disable automatic tidy and stop its task").click()
  await until(() => button("Review automatic project tidy")?.disabled === false)
  expect(calls.map((call) => call.path)).toEqual(["/api/memory/automatic", "/api/memory/automatic/disable"])
  expect(calls[1].body).toEqual({ expected: confirmed.requestID })
  expect(document.querySelector('[data-slot="memory-tidy-confirm"]')).toBeNull()
  expect(automatic).toMatchObject({ generation: confirmed.requestID, enabled: false })
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
  await until(() => button("Cancel task") !== undefined)
  expect(button("Start / continue")).toBeUndefined()
  expect(calls).toHaveLength(0)
  expect(document.body.textContent).toContain("Paused while usage is unconfirmed")
  expect(document.body.textContent).toContain("Unconfirmed reservations retained: 100")
  button("Cancel task").click()
  await until(() => document.body.textContent?.includes("Cancelled") === true)
  expect(calls.map((call) => call.path)).toEqual(["/api/memory/tidy/tidy-existing/cancel"])
  expect(document.body.textContent).toContain("110 / 200000")
})

test("a single-run checkpoint needs explicit approval of a larger total", async () => {
  await mount([
    {
      id: "tidy-budget",
      requestID: "admitted",
      sessionID: "session-tidy",
      layer: "project",
      directory: "/tidy-project",
      model: { id: "chat-b", providerID: "configured" },
      tokens: 200,
      dailyTokens: 1000,
      state: "active",
      budgetPause: { id: "checkpoint", budget: "run", utcDay: "2026-11-18", minimumTokens: 350 },
      executing: false,
      usage: { known: 160, reserved: 0, charged: 160, unknown: 0 },
      time: { created: 1, finished: null },
    },
  ])
  await until(() => !!button("Approve new limit and continue"))
  const approve = button("Approve new limit and continue")
  const input = document.querySelector<HTMLInputElement>('[data-slot="memory-tidy-task"] input[type="number"]')!
  expect(approve.disabled).toBe(true)
  input.value = "349"
  input.dispatchEvent(new Event("input", { bubbles: true }))
  expect(approve.disabled).toBe(true)
  expect(calls).toHaveLength(0)
  input.value = "350"
  input.dispatchEvent(new Event("input", { bubbles: true }))
  expect(approve.disabled).toBe(false)
  approve.click()
  await until(() => calls.length === 1)
  expect(calls[0].path).toBe("/api/memory/tidy/tidy-budget/start")
  expect(calls[0].query.get("checkpoint")).toBe("checkpoint")
  expect(calls[0].query.get("resumeTokens")).toBe("350")
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
