import { afterEach, expect, mock, test } from "bun:test"
import { Show, Suspense } from "solid-js"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import type { AssistantMessage, Message, Part, UserMessage } from "@zaovra-ai/sdk/v2"
import { I18nProvider } from "@zaovra-ai/ui/context/i18n"
import { dict } from "../../../ui/src/i18n/zh"
const app = await import("../../src/i18n/zh")

const dictionary: Record<string, string> = { ...dict, ...app.dict }
const language = {
  locale: () => "zh",
  t: (key: string, params?: Record<string, string | number | boolean>) =>
    (dictionary[key] ?? key).replace(/{{\s*(\w+)\s*}}/g, (_, name) => String(params?.[name] ?? "")),
}
const [route, setRoute] = createStore({ id: "" })
const records: { sessionID: string; messageID: string; action: string }[] = []
const [data, setData] = createStore({
  message: {} as Record<string, Message[]>,
  part: {} as Record<string, Part[]>,
  permission: {},
  question: {},
  live_shell: {},
  session_working: () => false,
})
const fixture = { fail: false, calls: 0, state: "failed", messageID: "assistant" }
const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
const sdk = {
  directory: "/fixture",
  client: {
    v2: {
      session: {
        outcome: async () => {
          fixture.calls++
          if (fixture.fail) throw new Error("fixture outcome unavailable")
          return {
            data: {
              data: { state: fixture.state, messageID: fixture.messageID, checks: [], missing: [], recentChecks: [] },
            },
          }
        },
        budget: async () => ({ data: { data: { used: { tokens: 0, durationMs: 0 }, limits: {} } } }),
        recover: async (input: (typeof records)[number]) => {
          records.push(input)
          return { data: {} }
        },
      },
    },
  },
}

// Only the service boundary is substituted; the real query, dock, summary,
// recovery buttons and error-card target render together in an isolated process.
mock.module("@solidjs/router", () => ({ useParams: () => route }))
mock.module("@/context/sdk", () => ({ useSDK: () => () => sdk }))
mock.module("@/context/server-sdk", () => ({
  useServerSDK: () => () => ({ scope: "local", transportConnected: () => true }),
}))
mock.module("@/context/server-sync", () => ({
  useServerSync: () => () => ({
    queryClient: client,
    session: { data, get: () => undefined, history: { complete: () => true } },
  }),
}))
mock.module("@/context/language", () => ({ useLanguage: () => language }))
mock.module("@/context/prompt", () => ({ usePrompt: () => ({ dirty: () => false, set: () => undefined }) }))
const { SessionOutcomeDock } = await import("../../src/pages/session/composer/session-outcome-dock")
const { ExecutionErrorCard } = await import("../../src/components/execution-error-card")

async function until(check: () => boolean) {
  const end = Date.now() + 2000
  while (!check() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 5))
  expect(check()).toBe(true)
}

const disposals: (() => void)[] = []
afterEach(() => {
  disposals.splice(0).forEach((dispose) => dispose())
  client.clear()
  document.body.replaceChildren()
  records.length = 0
})

function mount(kind: "provider" | "permission" | "query" | "success", changes: boolean, reopened: boolean) {
  const id = `${kind}-${changes}-${reopened}`
  setRoute("id", id)
  fixture.calls = 0
  fixture.fail = kind === "query"
  fixture.state = kind === "success" ? "completed" : "failed"
  fixture.messageID = "assistant"
  const user: UserMessage = {
    id: "user",
    role: "user",
    sessionID: id,
    time: { created: 1 },
    agent: "build",
    model: { providerID: "fixture", modelID: "offline" },
  }
  const assistant: AssistantMessage = {
    id: "assistant",
    role: "assistant",
    sessionID: id,
    parentID: user.id,
    agent: "build",
    mode: "build",
    providerID: "fixture",
    modelID: "offline",
    path: { cwd: "/fixture", root: "/fixture" },
    time: { created: 2, completed: 3 },
    finish: "stop",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    ...(kind === "success"
      ? {}
      : {
          error: { name: "UnknownError", data: { message: kind === "permission" ? "Permission denied" : "HTTP 503" } },
        }),
  }
  setData("message", id, [user, assistant])
  setData("part", "user", [])
  setData("part", "assistant", [])
  const host = document.createElement("main")
  document.body.append(host)
  const [card, setCard] = createStore({ mounted: false })
  const attach = () =>
    render(
      () => (
        <QueryClientProvider client={client}>
          <I18nProvider value={language}>
            <Show when={card.mounted}>
              <ExecutionErrorCard detail="HTTP 503" recoveryID="user" mascot={false} />
            </Show>
            <Suspense>
              <SessionOutcomeDock hasChanges={changes} changes={<button>2个文件变更</button>} />
            </Suspense>
          </I18nProvider>
        </QueryClientProvider>
      ),
      host,
    )
  const active = { dispose: attach() }
  disposals.push(() => active.dispose())
  const reopen = () => {
    active.dispose()
    client.clear()
    setData("message", id, [])
    setData("message", id, [{ ...user }, { ...assistant }])
    active.dispose = attach()
  }
  return { host, id, setCard, reopen }
}

for (const kind of ["provider", "permission", "query"] as const) {
  for (const changes of [false, true]) {
    for (const reopened of [false, true]) {
      test(`${kind}: recoverable with changes=${changes}, reopen with reloaded history=${reopened}`, async () => {
        const view = mount(kind, changes, reopened)
        await until(() => fixture.calls > 0)
        if (reopened) view.reopen()
        if (kind === "query") {
          await until(() => view.host.textContent!.includes(language.t("session.outcome.unavailable")))
          fixture.fail = false
          const refresh = [...view.host.querySelectorAll("button")].find(
            (button) => button.textContent === language.t("session.outcome.refresh"),
          )!
          expect(refresh).toBeTruthy()
          refresh.click()
          await until(() => fixture.calls >= 2)
        }
        const actions = () => document.querySelector<HTMLElement>("[data-component=session-recovery-actions]")
        await until(() => !!actions()?.textContent?.includes(language.t("session.outcome.continue")))
        view.setCard("mounted", true)
        await Promise.resolve()
        expect(actions()).not.toBeNull()
        view.setCard("mounted", false)
        await until(() => !!actions()?.isConnected)
        for (const action of ["continue", "retry", "abandon"] as const) {
          const button = [...actions()!.querySelectorAll<HTMLButtonElement>("button")].find(
            (item) => item.textContent === language.t(`session.outcome.${action}`),
          )
          // A menu is an acceptable presentation, but its action must be mounted
          // outside the optional summary. The repaired controls use a fixed row.
          expect(button).toBeTruthy()
          button!.click()
          await until(() => records.some((item) => item.action === action))
          expect(records.at(-1)).toMatchObject({ sessionID: view.id, messageID: "assistant", action })
        }
      })
    }
  }
}

test("a successful turn without changes does not acquire a recovery row or a footer", async () => {
  const view = mount("success", false, true)
  await until(() => fixture.calls > 0)
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(view.host.querySelector("[data-component=session-end-bar]")).toBeNull()
  expect(view.host.querySelector("[data-component=session-recovery-actions]")).toBeNull()
})

test("changing routes binds recovery to the newly queried session and assistant", async () => {
  const view = mount("provider", false, false)
  await until(() => !!document.querySelector("[data-component=session-recovery-actions]"))
  fixture.messageID = "new-assistant"
  setData(
    "message",
    "other-session",
    data.message[view.id].map((message) => ({
      ...message,
      sessionID: "other-session",
      id: message.role === "assistant" ? "new-assistant" : message.id,
    })),
  )
  setRoute("id", "other-session")
  await until(() => fixture.calls >= 2)
  await new Promise((resolve) => setTimeout(resolve, 20))
  const button = [
    ...document.querySelectorAll<HTMLButtonElement>("[data-component=session-recovery-actions] button"),
  ].find((item) => item.textContent === language.t("session.outcome.retry"))!
  button.click()
  await until(() => records.length > 0)
  expect(records[0]).toEqual({ sessionID: "other-session", messageID: "new-assistant", action: "retry" })
})
