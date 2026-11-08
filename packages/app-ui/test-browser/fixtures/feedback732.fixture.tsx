import { afterEach, expect, mock, test } from "bun:test"
import { Show, Suspense } from "solid-js"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import type { AssistantMessage, Todo, ToolPart, UserMessage, ZaovraClient } from "@zaovra-ai/sdk/v2/client"
import { I18nProvider } from "@zaovra-ai/ui/context/i18n"
import { DataProvider } from "@zaovra-ai/session-ui/context"
import { createServerSession } from "../../src/context/server-session"
const english = await import("../../src/i18n/en")
const chinese = await import("../../src/i18n/zh")
const uiEnglish = await import("../../../ui/src/i18n/en")
const uiChinese = await import("../../../ui/src/i18n/zh")
const dictionaries: Record<"en" | "zh", Record<string, string>> = {
  en: { ...uiEnglish.dict, ...english.dict },
  zh: { ...uiChinese.dict, ...chinese.dict },
}

const [route, setRoute] = createStore({ id: "session732", locale: "en" as "en" | "zh" })
const language = {
  locale: () => route.locale,
  t: (key: string, values?: Record<string, string | number | boolean>) =>
    dictionaries[route.locale][key]?.replace(/{{\s*(\w+)\s*}}/g, (_, name) => String(values?.[name] ?? "")) ?? key,
}
const requests: string[] = []
const durable: Todo[] = [{ content: "Saved completed item", status: "completed", priority: "medium" }]
const client = {
  v2: {
    session: {
      todos: async ({ sessionID }: { sessionID: string }) => {
        requests.push(sessionID)
        return { data: { data: sessionID === "session732" ? durable : [] } }
      },
    },
  },
} as unknown as ZaovraClient
let store = createServerSession(client)
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
const sdk = { directory: "/fixture732", client }
mock.module("@solidjs/router", () => ({ useParams: () => route, useLocation: () => ({ hash: "" }) }))
mock.module("@/context/sdk", () => ({ useSDK: () => () => sdk }))
mock.module("@/context/server-sdk", () => ({
  useServerSDK: () => () => ({ scope: "local732", transportConnected: () => true }),
}))
mock.module("@/context/server-sync", () => ({ useServerSync: () => () => ({ queryClient, session: store }) }))
const sync = {
  data: {
    session: [],
    get question() {
      return store.data.question
    },
    get permission() {
      return store.data.permission
    },
    get message() {
      return store.data.message
    },
    session_working: (id: string) => store.data.session_working(id),
  },
}
mock.module("@/context/sync", () => ({ useSync: () => () => sync }))
mock.module("@/context/language", () => ({ useLanguage: () => language }))
mock.module("@/context/permission", () => ({ usePermission: () => ({ autoResponds: () => false }) }))
mock.module("@/context/prompt", () => ({ usePrompt: () => ({ dirty: () => false, set() {} }) }))
const { ExecutionErrorCard } = await import("../../src/components/execution-error-card")
const { createSessionComposerController } = await import("../../src/pages/session/composer/session-composer-state")
const { SessionTodoDock } = await import("../../src/pages/session/composer/session-todo-dock")
const { PART_MAPPING } = await import("@zaovra-ai/session-ui/message-part")
const { Timeline } = await import("../../src/pages/session/timeline/rows")
const Tool = PART_MAPPING.tool!

const user: UserMessage = {
  id: "user732",
  sessionID: "session732",
  role: "user",
  time: { created: 1 },
  agent: "build",
  model: { providerID: "fixed", modelID: "offline" },
}
const assistant: AssistantMessage = {
  id: "assistant732",
  parentID: user.id,
  sessionID: "session732",
  role: "assistant",
  time: { created: 2, completed: 3 },
  agent: "build",
  mode: "build",
  providerID: "fixed",
  modelID: "offline",
  path: { cwd: "/fixture732", root: "/fixture732" },
  finish: "interrupted",
  error: { name: "MessageAbortedError", data: { message: "Stopped" } },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
}
const cancelled: ToolPart = {
  id: "tool732",
  callID: "call732",
  messageID: assistant.id,
  sessionID: "session732",
  type: "tool",
  tool: "task",
  state: { status: "error", input: {}, error: "Tool execution interrupted", time: { start: 2, end: 3 } },
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 20))
async function until(check: () => boolean) {
  const end = Date.now() + 1500
  while (!check() && Date.now() < end) await tick()
  expect(check()).toBe(true)
}
const closers: (() => void)[] = []
afterEach(() => {
  closers.splice(0).forEach((close) => close())
  queryClient.clear()
  document.body.replaceChildren()
  requests.length = 0
})
function seed(message = assistant) {
  store = createServerSession(client)
  store.set("message", "session732", [user, message])
  store.set("part", assistant.id, [cancelled])
  setRoute("id", "session732")
}
function mount(content: () => import("solid-js").JSX.Element) {
  const root = document.createElement("main")
  document.body.append(root)
  const dispose = render(
    () => (
      <QueryClientProvider client={queryClient}>
        <I18nProvider value={language}>
          <DataProvider directory="/fixture732" data={{ ...store.data, session: [] }}>
            <Suspense>{content()}</Suspense>
          </DataProvider>
        </I18nProvider>
      </QueryClientProvider>
    ),
    root,
  )
  const close = () => {
    dispose()
    root.remove()
  }
  closers.push(close)
  return { root, close }
}
function TodoView() {
  const controller = createSessionComposerController()
  return (
    <Show when={controller.dock()}>
      <SessionTodoDock
        todos={controller.todos()}
        delivered={controller.delivered()}
        deliveryKey={controller.deliveryKey()}
        collapsed={false}
        onToggle={() => {}}
        collapseLabel="Collapse"
        expandLabel="Expand"
        dockProgress={1}
      />
    </Show>
  )
}
test.each(["en", "zh"] as const)(
  "732 %s interruption is one divider in the conversation",
  async (locale) => {
    setRoute("locale", locale)
    seed()
    const rows = Timeline.constructMessageRows(
      user,
      (id) => store.data.part[id] ?? [],
      [assistant],
      0,
      false,
      "idle",
      false,
      false,
    )
    expect(rows.filter((row) => row._tag === "TurnDivider").map((row) => row.label)).toEqual(["interrupted"])
  },
)
test.each([
  { finish: "interrupted", error: "Tool execution interrupted", visible: false },
  { finish: "stop", error: "Tool execution interrupted", visible: true },
  { finish: "interrupted", error: "Permission denied", visible: true },
] as const)(
  "732 cancelled tool display preserves genuine failures: $finish/$error",
  async ({ finish, error, visible }) => {
    seed({ ...assistant, finish, error: finish === "stop" ? undefined : assistant.error })
    const part = { ...cancelled, state: { ...cancelled.state, status: "error" as const, error } }
    const view = mount(() => <Tool part={part} message={store.data.message.session732[1]} />)
    await tick()
    expect(view.root.querySelector('[data-kind="tool-error-card"]') !== null).toBe(visible)
    if (visible) expect(view.root.textContent).not.toContain("请展开详情查看原因，再告诉我如何继续")
  },
)
test.each(["en", "zh"] as const)(
  "732 %s actual failure keeps its details in the conversation",
  async (locale) => {
    setRoute("locale", locale)
    seed({ ...assistant, finish: "stop", error: { name: "UnknownError", data: { message: "HTTP 503" } } })
    const view = mount(() => <ExecutionErrorCard detailsOnly mascot={false} detail="HTTP 503" />)
    await tick()
    expect(view.root.querySelector('[data-component="execution-error-card"] h3') === null).toBe(true)
    expect(view.root.querySelector('[data-component="execution-error-card"] pre')?.textContent).toBe("HTTP 503")
  },
)
test.each(["en", "zh"] as const)(
  "732 %s completed summary hydrates on idle initial open and fresh-store reopen",
  async (locale) => {
    setRoute("locale", locale)
    seed({ ...assistant, finish: "stop", error: undefined })
    let view = mount(TodoView)
    await until(() => !!view.root.querySelector('[data-component="session-todo-dock"]'))
    expect(view.root.textContent).toContain(locale === "zh" ? "已完成 1 项" : "Completed: 1")
    expect(view.root.querySelector('[aria-expanded="false"]')).not.toBeNull()
    view.close()
    seed({ ...assistant, finish: "stop", error: undefined })
    view = mount(TodoView)
    await until(() => !!view.root.querySelector('[data-component="session-todo-dock"]'))
    ;(view.root.querySelector('[data-action="session-todo-toggle"]') as HTMLElement).click()
    expect(view.root.querySelector('[aria-expanded="true"]')).not.toBeNull()
    expect(view.root.textContent).toContain("Saved completed item")
    setRoute("id", "empty732")
    await tick()
    expect(view.root.querySelector('[data-component="session-todo-dock"]') === null).toBe(true)
    expect(requests).toEqual(["session732", "session732", "empty732"])
  },
)
