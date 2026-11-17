import { expect, test } from "bun:test"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import type { AssistantMessage, Message, SessionStatus, ToolPart, UserMessage } from "@zaovra-ai/sdk/v2"
import { DataProvider } from "@zaovra-ai/session-ui/context"
import { Part } from "@zaovra-ai/session-ui/message-part"
import { toolFailureMessage } from "@zaovra-ai/session-ui/tool-error-card"
import { I18nProvider } from "@zaovra-ai/ui/context/i18n"
import { DialogProvider } from "@zaovra-ai/ui/context/dialog"
import { FileComponentProvider } from "@zaovra-ai/ui/context/file"
import { dict } from "../../../ui/src/i18n/en"

test("a rejected write input with a file path is not described as a read failure", () => {
  const input = {
    tool: "write",
    input: { filePath: "F:/isolated/beta-proof.txt" },
    error: 'Invalid tool input: Missing key\n  at ["path"]',
  }
  const original = JSON.stringify(input)
  expect(toolFailureMessage(input).key).toBe("ui.toolErrorCard.actionable")
  expect(toolFailureMessage({ ...input, tool: "edit" }).key).toBe("ui.toolErrorCard.actionable")
  expect(toolFailureMessage({ ...input, tool: "read" }).key).toBe("ui.toolErrorCard.readAction")
  expect(toolFailureMessage({ error: "Unable to read /isolated/file.txt" }).key).toBe("ui.toolErrorCard.readAction")
  expect(toolFailureMessage({ ...input, metadata: { phase: "permission" } }).key).toBe(
    "ui.toolErrorCard.permissionAction",
  )
  expect(JSON.stringify(input)).toBe(original)
})

const user: UserMessage = {
  id: "msg_user",
  turn: "msg_user",
  seq: 0,
  sessionID: "ses_progress",
  role: "user",
  time: { created: 1 },
  agent: "build",
  model: { providerID: "offline", modelID: "offline" },
}
const first: AssistantMessage = {
  id: "msg_first",
  turn: user.id,
  seq: 1,
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
const last: AssistantMessage = { ...first, id: "msg_last", seq: 4, time: { created: 4 } }

function mount(tool: string, error = "Offline operation failed: original detail") {
  const failure: ToolPart = {
    id: "failure",
    callID: "failed-call",
    messageID: first.id,
    sessionID: user.sessionID,
    type: "tool",
    settledSeq: 3,
    failureDisposition: {
      version: 1,
      sessionID: user.sessionID,
      assistantMessageID: first.id,
      turnID: user.id,
      callID: "failed-call",
      basisSeq: 8,
      status: "unknown",
      reason: "invalidated",
    },
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
    parts: { [first.id]: [structuredClone(failure)], [last.id]: [] },
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
                session_status: { [user.sessionID]: state.status },
                message: { [user.sessionID]: state.messages },
                part: state.parts,
              }}
            >
              <Part message={first} part={state.parts[first.id][0]} />
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
    verdict(status: "recovered" | "exploratory" | "failed" | "interrupted" | "unknown") {
      setState("parts", first.id, 0, "failureDisposition", {
        version: 1,
        sessionID: user.sessionID,
        assistantMessageID: first.id,
        turnID: user.id,
        callID: "failed-call",
        basisSeq: 10,
        status,
        reason:
          status === "recovered"
            ? "same-operation"
            : status === "exploratory"
              ? "exploratory-miss"
              : status === "interrupted"
                ? "interrupted"
                : "unverified",
      })
    },
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
      view.setState("parts", last.id, [view.success])
      expectLight(view.host)
      view.host.querySelector<HTMLButtonElement>("[data-component=tool-recovery-summary] button")!.click()
      await Promise.resolve()
      expect(view.host.textContent).toContain("Offline operation failed: original detail")
      expect(view.host.textContent).toContain("index.html")
      view.settle()
      expect(view.host.querySelector("[data-kind=tool-error-card]")).not.toBeNull()
      view.verdict("recovered")
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
    view.setState("parts", last.id, [
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
    view.setState("messages", [
      user,
      first,
      last,
      { ...user, id: "msg_queued", seq: undefined, turn: undefined, time: { created: 7 } },
    ])
    expectLight(view.host)
    view.setState("messages", [
      user,
      first,
      { ...last, finish: "stop", time: { created: 4, completed: 6 } },
      { ...user, id: "msg_next_user", turn: "msg_next_user", seq: 20, time: { created: 7 } },
      {
        ...last,
        id: "msg_next_assistant",
        parentID: "msg_next_user",
        turn: "msg_next_user",
        seq: 21,
        time: { created: 8 },
      },
    ])
    expect(view.host.querySelector("[data-kind=tool-error-card]")).not.toBeNull()
  } finally {
    view.dispose()
  }
})

for (const status of ["exploratory", "interrupted", "failed", "unknown"] as const)
  test("typed DOM verdict " + status, () => {
    const view = mount("browser")
    try {
      view.settle()
      view.verdict(status)
      expect(!!view.host.querySelector("[data-kind=tool-error-card]")).toBe(status === "failed" || status === "unknown")
      expect(!!view.host.querySelector("[data-component=tool-recovery-summary]")).toBe(status === "exploratory")
      if (status === "interrupted") expect(view.host.textContent).toBe("")
    } finally {
      view.dispose()
    }
  })
test("busy old-service failures remain visible without a trusted report", () => {
  const view = mount("browser")
  try {
    view.setState("parts", first.id, 0, "failureDisposition", undefined)
    expect(view.host.querySelector("[data-kind=tool-error-card]")).not.toBeNull()
  } finally {
    view.dispose()
  }
})
