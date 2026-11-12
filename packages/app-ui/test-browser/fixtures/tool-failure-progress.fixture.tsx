import { expect, test } from "bun:test"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import type { AssistantMessage, Message, SessionStatus, ToolPart, UserMessage } from "@zaovra-ai/sdk/v2"
import { DataProvider } from "@zaovra-ai/session-ui/context"
import { Part } from "@zaovra-ai/session-ui/message-part"
import { I18nProvider } from "@zaovra-ai/ui/context/i18n"
import { DialogProvider } from "@zaovra-ai/ui/context/dialog"
import { FileComponentProvider } from "@zaovra-ai/ui/context/file"
import { dict } from "../../../ui/src/i18n/en"

const user: UserMessage = {
  id: "user",
  sessionID: "progress",
  role: "user",
  time: { created: 1 },
  agent: "build",
  model: { providerID: "offline", modelID: "offline" },
}
const first: AssistantMessage = {
  id: "first",
  sessionID: user.sessionID,
  parentID: user.id,
  role: "assistant",
  time: { created: 2, completed: 3 },
  finish: "tool-calls",
  agent: "build",
  mode: "build",
  providerID: "offline",
  modelID: "offline",
  path: { cwd: "/fixture", root: "/fixture" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
}
const last: AssistantMessage = { ...first, id: "last", time: { created: 4 } }

function mount(tool: string, error = "Offline operation failed: original detail") {
  const failure: ToolPart = {
    id: "failure",
    callID: "failed-call",
    messageID: first.id,
    sessionID: user.sessionID,
    type: "tool",
    tool,
    state: {
      status: "error",
      input: { target: "index.html", action: "update" },
      error,
      time: { start: 2, end: 3 },
    },
  }
  const success: ToolPart = {
    ...failure,
    id: "success",
    callID: "successful-call",
    messageID: last.id,
    state: {
      status: "completed",
      input: failure.state.input,
      output: "Completed",
      title: tool,
      metadata: {},
      time: { start: 4, end: 5 },
    },
  }
  const [state, setState] = createStore<{
    messages: Message[]
    parts: Record<string, ToolPart[]>
    status: SessionStatus
  }>({
    messages: [user, first, last],
    parts: { first: [failure], last: [] },
    status: { type: "busy" },
  })
  const feedback: string[] = []
  const host = document.createElement("main")
  document.body.append(host)
  const dispose = render(
    () => (
      <I18nProvider value={{ locale: () => "en", t: (key) => dict[key as keyof typeof dict] ?? key }}>
        <DialogProvider>
          <FileComponentProvider component={() => null}>
            <DataProvider
              directory="/fixture"
              onFeedback={(error) => feedback.push(error)}
              data={{
                session: [],
                session_diff: {},
                session_status: { progress: state.status },
                message: { progress: state.messages },
                part: state.parts,
              }}
            >
              <Part message={first} part={failure} />
            </DataProvider>
          </FileComponentProvider>
        </DialogProvider>
      </I18nProvider>
    ),
    host,
  )
  return {
    host,
    failure,
    success,
    state,
    setState,
    feedback,
    settle(finish = "stop") {
      setState("messages", [user, first, { ...last, finish, time: { created: 4, completed: 6 } }])
      setState("status", { type: "idle" })
    },
    dispose() {
      dispose()
      host.remove()
    },
  }
}

function expectLight(host: HTMLElement) {
  expect(host.querySelector("[data-component=tool-recovery-summary]")).not.toBeNull()
  expect(host.querySelector("[data-kind=tool-error-card]")).toBeNull()
  expect(host.textContent).not.toContain(dict["ui.toolErrorCard.feedback"])
}

test.each(["browser", "apply_patch", "question"])(
  "%s failure stays light during same-turn retry and successful continuation",
  async (tool) => {
    const view = mount(tool)
    const original = JSON.stringify(view.failure)
    try {
      expectLight(view.host)
      view.setState("parts", "last", [view.success])
      expectLight(view.host)
      view.host.querySelector<HTMLButtonElement>("[data-component=tool-recovery-summary] button")!.click()
      await Promise.resolve()
      expect(view.host.textContent).toContain("Offline operation failed: original detail")
      expect(view.host.textContent).toContain("index.html")
      view.settle()
      expect(view.host.querySelector("[data-kind=tool-error-card]")).toBeNull()
      expect(view.feedback).toEqual([])
      expect(JSON.stringify(view.failure)).toBe(original)
    } finally {
      view.dispose()
    }
  },
)

test("a user-dismissed question keeps its dismissal acknowledgement during the turn", () => {
  const view = mount("question", "Error: The user dismissed this question")
  try {
    expect(view.host.textContent).toBe(dict["ui.messagePart.questions.dismissed"])
    expect(view.host.querySelector("[data-component=tool-recovery-summary]")).toBeNull()
    expect(view.host.querySelector("[data-kind=tool-error-card]")).toBeNull()
    expect(view.feedback).toEqual([])
  } finally {
    view.dispose()
  }
})

test.each(["stop", "stopped", "interrupted"])(
  "unrecovered failure gains its full card and exact feedback after %s",
  (finish) => {
    const view = mount("browser")
    try {
      expectLight(view.host)
      view.settle(finish)
      expect(view.host.querySelector("[data-kind=tool-error-card]")).not.toBeNull()
      const feedback = [...view.host.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent === dict["ui.toolErrorCard.feedback"],
      )
      expect(feedback).toBeDefined()
      feedback!.click()
      expect(view.feedback).toEqual(["Offline operation failed: original detail"])
    } finally {
      view.dispose()
    }
  },
)

test("same tool succeeding on another target cannot resolve the original failure", () => {
  const view = mount("browser")
  try {
    expectLight(view.host)
    view.setState("parts", "last", [
      { ...view.success, state: { ...view.success.state, input: { target: "other.html", action: "update" } } },
    ])
    expectLight(view.host)
    view.settle()
    expect(view.host.querySelector("[data-kind=tool-error-card]")).not.toBeNull()
  } finally {
    view.dispose()
  }
})

test("queued input does not end the active turn, but another running turn cannot quiet its old failure", () => {
  const view = mount("browser")
  try {
    view.setState("messages", [user, first, last, { ...user, id: "queued", time: { created: 7 } }])
    expectLight(view.host)
    view.setState("messages", [
      user,
      first,
      { ...last, finish: "stop", time: { created: 4, completed: 6 } },
      { ...user, id: "next-user", time: { created: 7 } },
      { ...last, id: "next-assistant", parentID: "next-user", time: { created: 8 } },
    ])
    expect(view.host.querySelector("[data-kind=tool-error-card]")).not.toBeNull()
  } finally {
    view.dispose()
  }
})
