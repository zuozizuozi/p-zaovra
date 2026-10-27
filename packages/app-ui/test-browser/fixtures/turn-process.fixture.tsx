import { expect, test } from "bun:test"
import { createStore } from "solid-js/store"
import { Show } from "solid-js"
import { render } from "solid-js/web"
import type { AssistantMessage, Part, ToolPart, UserMessage } from "@zaovra-ai/sdk/v2"
import { I18nProvider } from "@zaovra-ai/ui/context/i18n"
import { dict } from "../../../ui/src/i18n/zh"
import { ToolErrorCard, ToolFailureNotice } from "../../../session-ui/src/components/tool-error-card"
import { ToolRecoverySummary } from "../../../session-ui/src/components/tool-recovery-summary"
import { quietToolFailures } from "../../../session-ui/src/components/tool-recovery"
import { TurnProcessSummary, settledTurnStatus } from "../../src/pages/session/timeline/turn-process-summary"

const user: UserMessage = {
  id: "user",
  sessionID: "session",
  role: "user",
  time: { created: 1 },
  agent: "build",
  model: { providerID: "fixture", modelID: "offline" },
}
const first: AssistantMessage = {
  id: "first",
  sessionID: "session",
  role: "assistant",
  parentID: "user",
  time: { created: 2, completed: 3 },
  finish: "tool-calls",
  agent: "build",
  mode: "build",
  providerID: "fixture",
  modelID: "offline",
  path: { cwd: "/test", root: "/test" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
}
const last: AssistantMessage = { ...first, id: "last", finish: "stop", time: { created: 4, completed: 5 } }
const failure: ToolPart = {
  id: "read-failure",
  callID: "read-call",
  messageID: first.id,
  sessionID: user.sessionID,
  type: "tool",
  tool: "read",
  state: {
    status: "error",
    input: { filePath: "missing.html" },
    error: "File not found: missing.html",
    time: { start: 2, end: 3 },
  },
}
const success: ToolPart = {
  ...failure,
  id: "write",
  callID: "write",
  messageID: last.id,
  tool: "write",
  state: {
    status: "completed",
    input: { filePath: "index.html", content: "<h1>Ready</h1>" },
    output: "Written",
    title: "write",
    metadata: {},
    time: { start: 4, end: 5 },
  },
}
const request: Part = {
  id: "request",
  messageID: user.id,
  sessionID: user.sessionID,
  type: "text",
  text: "做一个小游戏",
}
const answer: Part = { ...request, id: "answer", messageID: last.id, text: "小游戏已做好，打开 index.html 即可游玩。" }
const app = await import("../../src/i18n/zh")
const dictionary: Record<string, string> = { ...dict, ...app.dict }
const value = {
  locale: () => "zh",
  t: (key: string, params?: Record<string, string | number | boolean>) =>
    (dictionary[key] ?? key).replace(/{{\s*(\w+)\s*}}/g, (_, name) => String(params?.[name] ?? "")),
}

function mount(blocked = false, before = false) {
  const tools = blocked ? [failure] : [failure, success]
  const parts = { user: [request], first: [failure], last: blocked ? [answer] : [success, answer] }
  const quiet = quietToolFailures({ message: last, messages: [user, first, last], parts, working: false })
  const [state, setState] = createStore({ folded: true })
  const host = document.createElement("main")
  document.body.append(host)
  const dispose = render(
    () => (
      <I18nProvider value={value}>
        <div data-component="fixture-turn" style={{ "max-width": "720px", margin: "64px auto", padding: "24px" }}>
          <p style={{ "text-align": "right", "margin-bottom": "24px" }}>做一个小游戏</p>
          <Show when={!before} fallback={<button class="text-xs text-text-weak">用时 4 秒 ⌄</button>}>
            <TurnProcessSummary
              seconds={4}
              tools={tools}
              status={settledTurnStatus(
                [first, last],
                quiet.length !== tools.filter((part) => part.state.status === "error").length,
              )}
              folded={state.folded}
              onToggle={() => setState("folded", !state.folded)}
            />
          </Show>
          <Show when={before}>
            <ToolErrorCard tool="read" error="File not found: missing.html" />
          </Show>
          <Show when={!before && !state.folded && quiet.length > 0}>
            <ToolRecoverySummary parts={quiet} recovered={false} />
          </Show>
          <p data-slot="final-answer" style={{ "margin-top": "24px", "margin-bottom": "24px", "font-size": "16px" }}>
            {blocked ? "无法读取所需文件，当前任务未能完成。" : answer.text}
          </p>
          <Show when={!before && blocked}>
            <ToolFailureNotice error="File not found: missing.html" />
            <ToolErrorCard tool="read" error="File not found: missing.html" />
          </Show>
        </div>
      </I18nProvider>
    ),
    host,
  )
  return {
    host,
    state,
    dispose: () => {
      dispose()
      host.remove()
    },
  }
}

async function evidence(name: string, host: HTMLElement) {
  const folder = process.env.ZAOVRA_COMPONENT_EVIDENCE
  if (!folder) return
  await Bun.write(
    `${folder}/${name}.html`,
    `<!doctype html><html><head><meta charset="utf-8"><title>${name} · 组件DOM取证</title><link rel="stylesheet" href="${process.env.ZAOVRA_COMPONENT_CSS}"><style>body{background:#161616;color:#e6e6e6;font-family:Segoe UI,Microsoft YaHei,sans-serif}button{cursor:pointer}main{min-height:680px}</style></head><body>${document.getElementById("zaovra-icon-sprite")?.outerHTML ?? ""}${host.outerHTML}</body></html>`,
  )
}

test("normal completion folds exploratory failure into a neutral count, and expansion preserves original input and error", async () => {
  const before = mount(false, true)
  await evidence("before-read-then-complete", before.host)
  before.dispose()
  const fixture = mount()
  try {
    expect(fixture.host.textContent).toContain("1个失败")
    expect(fixture.host.textContent).toContain("用时 4 秒")
    expect(fixture.host.querySelector("[data-slot=turn-terminal-status]")).toBeNull()
    expect(fixture.host.textContent).not.toContain("当前未执行")
    expect(fixture.host.querySelector("[data-kind=tool-error-card]")).toBeNull()
    expect(fixture.host.querySelector("pre")).toBeNull()
    await evidence("after-read-then-complete-folded", fixture.host)
    fixture.host.querySelector<HTMLButtonElement>("[data-slot=process-counts]")!.click()
    expect(fixture.state.folded).toBe(false)
    fixture.host.querySelector<HTMLButtonElement>("[data-component=tool-recovery-summary] button")!.click()
    await Promise.resolve()
    expect(fixture.host.textContent).toContain("missing.html")
    expect(fixture.host.textContent).toContain("File not found: missing.html")
    expect(fixture.host.querySelector("[data-component=tool-error-card-icon]")).toBeNull()
    await evidence("after-read-then-complete-expanded", fixture.host)
  } finally {
    fixture.dispose()
  }
})

test("blocking failure remains visible after the answer with an explanation and actionable next step", async () => {
  const before = mount(true, true)
  await evidence("before-blocking-failure", before.host)
  before.dispose()
  const fixture = mount(true)
  try {
    const notice = fixture.host.querySelector("[data-component=tool-failure-notice]")!
    const answer = fixture.host.querySelector("[data-slot=final-answer]")!
    expect(fixture.host.querySelector("[data-kind=tool-error-card]")).not.toBeNull()
    expect(fixture.host.querySelector("[data-slot=turn-terminal-status]")?.textContent).toBe("需要处理")
    expect(notice.textContent).toContain("File not found: missing.html")
    expect(notice.textContent).toContain("检查路径或提供文件后重试")
    expect(answer.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
    await evidence("after-blocking-failure", fixture.host)
  } finally {
    fixture.dispose()
  }
})

test("stopped and interrupted headings keep their actual terminal state", () => {
  expect(settledTurnStatus([{ ...last, finish: "stopped" }], false)).toBe("stopped")
  expect(settledTurnStatus([{ ...last, finish: "interrupted" }], false)).toBe("interrupted")
  expect(
    settledTurnStatus([{ ...last, error: { name: "MessageAbortedError", data: { message: "aborted" } } }], false),
  ).toBe("interrupted")
  expect(settledTurnStatus([last], false)).toBeUndefined()
})

test("English terminal headings render stopped and interrupted without an idle label", async () => {
  const english = await import("../../src/i18n/en")
  const dictionary: Record<string, string> = english.dict
  const host = document.createElement("div")
  const [state, setState] = createStore({ status: "stopped" as "stopped" | "interrupted" | undefined })
  const dispose = render(
    () => (
      <I18nProvider
        value={{
          locale: () => "en",
          t: (key, params) =>
            (dictionary[key] ?? key).replace(/{{\s*(\w+)\s*}}/g, (_, name) => String(params?.[name] ?? "")),
        }}
      >
        <TurnProcessSummary seconds={4} tools={[]} status={state.status} folded onToggle={() => {}} />
      </I18nProvider>
    ),
    host,
  )
  try {
    expect(host.textContent).toContain("Stopped")
    setState("status", "interrupted")
    expect(host.textContent).toContain("Interrupted")
    setState("status", undefined)
    expect(host.textContent).toBe("Took 4s ⌄")
    expect(host.textContent).not.toContain("Not executing")
  } finally {
    dispose()
  }
})

test("uncertain effects explain that current state must be checked before retrying", () => {
  const host = document.createElement("div")
  const dispose = render(
    () => (
      <I18nProvider value={value}>
        <ToolFailureNotice error="Outcome may have occurred; partial write" />
      </I18nProvider>
    ),
    host,
  )
  try {
    expect(host.textContent).toContain("可能已部分生效")
    expect(host.textContent).toContain("先检查当前文件或进程状态")
  } finally {
    dispose()
  }
})
