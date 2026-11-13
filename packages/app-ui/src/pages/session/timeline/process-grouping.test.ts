import { expect, mock, test } from "bun:test"
import type { AssistantMessage, Part, SessionStatus, ToolPart, UserMessage } from "@zaovra-ai/sdk/v2"
// Bun does not resolve Vite worker URLs; the renderer is not mounted in these row guards.
mock.module("../../../../../session-ui/src/components/markdown-shiki.worker.ts?worker&url", () => ({
  default: "unused-worker-url",
}))
const { Timeline, TimelineRow } = await import("./rows")

for (const status of ["busy", "retry"] as const) {
  test("759 active " + status + " keeps shell row keys through completion", () => {
    const running = rows(status, true, false, false)
    const completed = rows(status, true)
    expect(completed.map(TimelineRow.key)).toEqual(running.map(TimelineRow.key))
    expect(completed.filter((row) => row._tag === "AssistantPart").map((row) => row.group.type)).toEqual([
      "part",
      "part",
      "part",
    ])
  })
}

for (const state of [
  { status: "idle", active: true },
  { status: "busy", active: false },
] as const) {
  test("759 " + state.status + " active=" + state.active + " retains completed process aggregation", () => {
    const parts = rows(state.status, state.active).filter((row) => row._tag === "AssistantPart")
    expect(parts.map((row) => row.group.type)).toEqual(["context", "part"])
    expect(parts[0]?.group).toMatchObject({
      kind: "command",
      refs: [
        { messageID: "msg_a", partID: "shell_1" },
        { messageID: "msg_a", partID: "shell_2" },
      ],
    })
    expect(parts[1]?.group.key).toBe("part:msg_a:following")
  })
}

test("759 active interruption keeps shells on both sides as resident part rows", () => {
  const result = rows("busy", true, true)
  expect(result.filter((row) => row._tag === "AssistantPart").map((row) => row.group.key)).toEqual([
    "part:msg_a:shell_1",
    "part:msg_b:shell_2",
    "part:msg_b:following",
  ])
  expect(result.filter((row) => row._tag === "TurnDivider").map((row) => row.label)).toEqual(["interrupted"])
})

test("a turn paused because the user declined a permission says so instead of just 'interrupted'", () => {
  const user = { id: "msg_user", role: "user" } as UserMessage
  const declined = {
    id: "msg_a",
    role: "assistant",
    finish: "interrupted",
    structured: { zaovraTermination: { category: "interrupted", source: "permission" } },
  } as AssistantMessage
  const stopped = { ...declined, structured: { zaovraTermination: { category: "interrupted", source: "user" } } }
  const label = (assistant: AssistantMessage) =>
    Timeline.constructMessageRows(user, () => [], [assistant], 0, true, "idle", false, false)
      .filter((row) => row._tag === "TurnDivider")
      .map((row) => row.label)
  expect(label(declined)).toEqual(["declined"])
  expect(label(stopped)).toEqual(["interrupted"])
})

test("759 idle interruption keeps terminal groups separated by the divider", () => {
  const result = rows("idle", true, true)
  expect(result.map((row) => row._tag)).toEqual([
    "UserMessage",
    "AssistantHeading",
    "AssistantPart",
    "TurnDivider",
    "AssistantPart",
    "AssistantPart",
  ])
  expect(result.filter((row) => row._tag === "AssistantPart").map((row) => row.group)).toMatchObject([
    { type: "context", kind: "command", refs: [{ messageID: "msg_a", partID: "shell_1" }] },
    { type: "context", kind: "command", refs: [{ messageID: "msg_b", partID: "shell_2" }] },
    { type: "part", key: "part:msg_b:following" },
  ])
})

function rows(status: SessionStatus["type"], active: boolean, interrupted = false, completed = true) {
  const user = { id: "msg_user", role: "user" } as UserMessage
  const assistants = [
    { id: "msg_a", role: "assistant", ...(interrupted ? { finish: "interrupted" } : {}) },
    ...(interrupted ? [{ id: "msg_b", role: "assistant" }] : []),
  ] as AssistantMessage[]
  const parts: Part[] = [
    shell("shell_1", "msg_a", completed),
    shell("shell_2", interrupted ? "msg_b" : "msg_a", completed),
    {
      id: "following",
      messageID: interrupted ? "msg_b" : "msg_a",
      sessionID: "ses",
      type: "text",
      text: "Following shells.",
    },
  ]
  return Timeline.constructMessageRows(
    user,
    (id) => parts.filter((part) => part.messageID === id),
    assistants,
    0,
    true,
    status,
    active,
    false,
  )
}

function shell(id: string, messageID: string, completed: boolean): ToolPart {
  return {
    id,
    messageID,
    sessionID: "ses",
    type: "tool",
    tool: "bash",
    callID: id,
    state: completed
      ? {
          status: "completed",
          input: { command: id },
          output: "done",
          title: id,
          metadata: {},
          time: { start: 0, end: 1 },
        }
      : { status: "running", input: { command: id }, title: id, metadata: {}, time: { start: 0 } },
  }
}
