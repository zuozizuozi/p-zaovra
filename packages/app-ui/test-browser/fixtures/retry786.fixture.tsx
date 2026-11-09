import { afterEach, expect, mock, test } from "bun:test"
import { For, Show, createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import type { AssistantMessage, Message, SessionStatus, UserMessage } from "@zaovra-ai/sdk/v2"
import { I18nProvider } from "@zaovra-ai/ui/context/i18n"
import { FileComponentProvider } from "@zaovra-ai/ui/context/file"
import { DialogProvider } from "@zaovra-ai/ui/context/dialog"
import { DataProvider } from "@zaovra-ai/session-ui/context"
import { SessionRetry } from "@zaovra-ai/session-ui/session-retry"
import { SessionTurn } from "@zaovra-ai/session-ui/session-turn"
import { Timeline } from "../../src/pages/session/timeline/rows"
import { TurnProcessSummary, settledTurnStatus } from "../../src/pages/session/timeline/turn-process-summary"

const english = await import("../../src/i18n/en")
const chinese = await import("../../src/i18n/zh")
const uiEnglish = await import("../../../ui/src/i18n/en")
const uiChinese = await import("../../../ui/src/i18n/zh")
const dictionaries: Record<"en" | "zh", Record<string, string>> = {
  en: { ...uiEnglish.dict, ...english.dict },
  zh: { ...uiChinese.dict, ...chinese.dict },
}
const [language, setLanguage] = createStore({ locale: "zh" as "en" | "zh" })
const i18n = {
  locale: () => language.locale,
  t: (key: string, values?: Record<string, string | number | boolean>) =>
    (dictionaries[language.locale][key] ?? key).replace(/{{\s*(\w+)\s*}}/g, (_, name) => String(values?.[name] ?? "")),
}
mock.module("@/context/language", () => ({ useLanguage: () => i18n }))
const { ExecutionErrorCard } = await import("../../src/components/execution-error-card")

const user: UserMessage = {
  id: "user786",
  sessionID: "retry786",
  role: "user",
  time: { created: 1 },
  agent: "build",
  model: { providerID: "fixed", modelID: "offline" },
}
const failed: AssistantMessage = {
  id: "failed786",
  parentID: user.id,
  sessionID: user.sessionID,
  role: "assistant",
  time: { created: 2, completed: 3 },
  agent: "build",
  mode: "build",
  providerID: "fixed",
  modelID: "offline",
  path: { cwd: "/retry786", root: "/retry786" },
  error: { name: "APIError", data: { message: "HTTP 503 provider detail", isRetryable: true } },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
}
const success: AssistantMessage = {
  ...failed,
  id: "success786",
  time: { created: 4, completed: 5 },
  error: undefined,
  finish: "stop",
}
const retry = (): SessionStatus & { type: "retry" } => ({
  type: "retry",
  attempt: 1,
  message: "HTTP 503 provider detail",
  next: Date.now() + 3000,
})
const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach((close) => close()))
function mount(content: () => import("solid-js").JSX.Element) {
  const root = document.createElement("main")
  document.body.append(root)
  const dispose = render(
    () => (
      <I18nProvider value={i18n}>
        <DialogProvider>
          <FileComponentProvider component={() => null}>{content()}</FileComponentProvider>
        </DialogProvider>
      </I18nProvider>
    ),
    root,
  )
  cleanups.push(() => {
    dispose()
    root.remove()
  })
  return root
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
function assertQuiet(root: HTMLElement, attempt: number) {
  const line = root.querySelector('[data-slot="session-turn-retry"]')!
  expect(line.textContent).toBe(
    language.locale === "zh"
      ? "网络波动，正在重试（第 " + attempt + " 次）"
      : "Network issue, retrying (attempt " + attempt + ")",
  )
  expect(line.getAttribute("role")).toBe("status")
  expect(line.getAttribute("aria-atomic")).toBe("true")
  expect(line.querySelector('[data-component="card"]')).toBeNull()
  expect(root.querySelector("details")).toBeNull()
  expect(root.querySelector('[data-component="execution-error-card"]')).toBeNull()
  expect(root.textContent).not.toContain("HTTP 503")
  expect(root.textContent).not.toMatch(/执行出错|需要处理|Execution error|Action needed|技术详情|Technical details/)
}
test.each(["zh", "en"] as const)(
  "786 %s shared retry is one neutral live line and clears after recovery",
  async (locale) => {
    setLanguage("locale", locale)
    const [state, setState] = createStore<{ status: SessionStatus; show: boolean }>({ status: retry(), show: true })
    const root = mount(() => <SessionRetry status={state.status} show={state.show} />)
    assertQuiet(root, 1)
    setState("status", { ...retry(), attempt: 2 })
    assertQuiet(root, 2)
    setState("show", false)
    expect(root.textContent).toBe("")
    setState("show", true)
    setState("status", { type: "busy" })
    expect(root.textContent).toBe("")
    setState("status", { type: "idle" })
    expect(root.textContent).toBe("")
    await tick()
  },
)

test.each(["zh", "en"] as const)(
  "786 %s legacy turn hides retry failures and clears recovered history",
  async (locale) => {
    setLanguage("locale", locale)
    const [state, setState] = createStore<{ status: SessionStatus; messages: Message[] }>({
      status: retry(),
      messages: [user, failed],
    })
    const root = mount(() => (
      <DataProvider
        directory="/retry786"
        data={{
          session: [],
          session_status: {},
          session_diff: {},
          message: { retry786: [] },
          part: {},
        }}
      >
        <SessionTurn
          sessionID={user.sessionID}
          messageID={user.id}
          messages={state.messages}
          active
          status={state.status}
        />
      </DataProvider>
    ))
    assertQuiet(root, 1)
    setState("status", { type: "busy" })
    expect(root.textContent).not.toContain("HTTP 503")
    setState("messages", [user, failed, success])
    setState("status", { type: "idle" })
    expect(root.querySelector('[data-slot="session-turn-retry"]')).toBeNull()
    expect(root.textContent).not.toContain("HTTP 503")
    setState("messages", [user, failed])
    expect(root.textContent).toContain("HTTP 503 provider detail")
    await tick()
  },
)

test.each(["zh", "en"] as const)(
  "786 %s V2 rows recover cleanly and exhausted failure keeps functional actions",
  async (locale) => {
    setLanguage("locale", locale)
    const [state, setState] = createStore<{ status: SessionStatus; messages: AssistantMessage[] }>({
      status: retry(),
      messages: [failed],
    })
    let configured = 0
    const root = mount(() => {
      const working = () => state.status.type !== "idle"
      const rows = createMemo(() =>
        Timeline.constructMessageRows(user, () => [], state.messages, 0, false, state.status.type, true, true),
      )
      return (
        <>
          <TurnProcessSummary
            tools={[]}
            status={settledTurnStatus(state.messages, false)}
            working={working()}
            folded
            onToggle={() => {}}
          />
          <For each={rows()}>
            {(row) => (
              <>
                <Show when={row._tag === "Retry"}>
                  <SessionRetry status={state.status} />
                </Show>
                <Show when={row._tag === "Error" ? row : undefined}>
                  {(error) => (
                    <ExecutionErrorCard
                      detailsOnly
                      mascot={false}
                      detail={error().text}
                      onConfigure={() => configured++}
                    />
                  )}
                </Show>
              </>
            )}
          </For>
        </>
      )
    })
    assertQuiet(root, 1)
    setState("status", { type: "busy" })
    expect(root.querySelector('[data-slot="turn-terminal-status"]')).toBeNull()
    expect(root.querySelector("details")).toBeNull()
    setState("messages", [failed, success])
    setState("status", { type: "idle" })
    expect(root.textContent).not.toMatch(/HTTP 503|重试|retrying|需要处理|Action needed/)
    expect(root.querySelector("details")).toBeNull()
    setState("messages", [failed])
    expect(root.querySelector('[data-slot="turn-terminal-status"]')?.textContent).toBe(
      locale === "zh" ? "需要处理" : "Action needed",
    )
    const details = root.querySelector("details")!
    expect(details.open).toBe(false)
    details.open = true
    expect(details.querySelector("pre")?.textContent).toBe("HTTP 503 provider detail")
    const configure = [...details.querySelectorAll("button")].find(
      (button) => button.textContent === i18n.t("error.checkModelService"),
    )!
    configure.click()
    expect(configured).toBe(1)
    let feedback: unknown
    const listener = (event: Event) => {
      feedback = (event as CustomEvent).detail
    }
    window.addEventListener("zaovra:feedback", listener)
    details.querySelector<HTMLButtonElement>('[data-feedback-entry="error"]')!.click()
    window.removeEventListener("zaovra:feedback", listener)
    expect(feedback).toMatchObject({ error: "HTTP 503 provider detail" })
    await tick()
  },
)

test("786 an unrelated historical failure remains visible while the current turn retries", () => {
  const rows = Timeline.constructMessageRows(user, () => [], [failed], 0, false, "retry", false, true)
  expect(rows.filter((row) => row._tag === "Error")).toHaveLength(1)
  expect(rows.filter((row) => row._tag === "Retry")).toHaveLength(0)
  const aborted = {
    ...failed,
    finish: "interrupted",
    error: { name: "MessageAbortedError" as const, data: { message: "Stopped" } },
  }
  const stopped = Timeline.constructMessageRows(user, () => [], [failed, aborted], 0, false, "idle", false, true)
  expect(stopped.filter((row) => row._tag === "Error")).toHaveLength(0)
  expect(stopped.filter((row) => row._tag === "TurnDivider")).toHaveLength(1)
})
