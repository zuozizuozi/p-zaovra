import { expect, test } from "bun:test"
import type { AssistantMessage, Message, Part, ToolPart } from "@zaovra-ai/sdk/v2"
import { recoveredToolFailures } from "./tool-recovery"

const user: Message = {
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
const last: AssistantMessage = { ...first, id: "last", time: { created: 4, completed: 5 }, finish: "stop" }
const failure: ToolPart = {
  id: "failure",
  messageID: first.id,
  sessionID: "session",
  type: "tool",
  tool: "edit",
  callID: "failure",
  state: {
    status: "error",
    input: { path: "app.ts", oldString: "old", newString: "fixed" },
    error: "Could not find oldString",
    time: { start: 2, end: 3 },
  },
}
const success: ToolPart = {
  ...failure,
  id: "success",
  messageID: last.id,
  callID: "success",
  state: {
    status: "completed",
    input: { path: "app.ts", oldString: " old ", newString: "fixed" },
    output: "Edited",
    title: "edit",
    metadata: {},
    time: { start: 4, end: 5 },
  },
}
function recovered(parts: Record<string, Part[]>, messages: readonly Message[] = [user, first, last], working = false) {
  return recoveredToolFailures({ message: first, messages, parts, working }).map((part) => part.id)
}

test("exact edit recovery is display-only and closes only after the turn settles", () => {
  const parts = { first: [failure], last: [success] }
  expect(recovered(parts)).toEqual([failure.id])
  expect(failure.state.status).toBe("error")
  expect(recovered(parts, [user, first, last], true)).toEqual([])
  expect(recovered(parts, [user, first, last, { ...user, id: "queued", time: { created: 6 } }], true)).toEqual([])
  expect(recovered(parts, [user, first, { ...last, finish: "tool-calls" }])).toEqual([])
  expect(recovered(parts, [user, first, { ...last, time: { created: 4 } }])).toEqual([])
})

test("different target or replacement, earlier success and formatting failure do not resolve an edit", () => {
  if (success.state.status !== "completed") throw new Error("Expected completed fixture")
  const state = success.state
  for (const changed of [
    { ...success, state: { ...state, input: { ...state.input, path: "other.ts" } } },
    { ...success, state: { ...state, input: { ...state.input, newString: "unrelated" } } },
    { ...success, state: { ...state, input: { ...state.input, oldString: "different block" } } },
    { ...success, state: { ...state, input: { ...state.input, replaceAll: true } } },
    { ...success, tool: "write", state: { ...state, input: { path: "app.ts", content: "contains fixed" } } },
    { ...success, state: { ...state, time: { start: 1, end: 1 } } },
    { ...success, state: { ...state, metadata: { formatting: { failed: ["formatter"] } } } },
  ])
    expect(recovered({ first: [failure], last: [changed] })).toEqual([])
})

test("verification failures stay visible even when the exact command later succeeds", () => {
  if (failure.state.status !== "error" || success.state.status !== "completed") throw new Error("Expected fixtures")
  const input = { command: "bun test", verification: "test" }
  expect(
    recovered({
      first: [{ ...failure, tool: "bash", state: { ...failure.state, input, error: "Verification failed: test" } }],
      last: [
        {
          ...success,
          tool: "bash",
          state: { ...success.state, input, metadata: { exit: 0, verification: { exit: 0 } } },
        },
      ],
    }),
  ).toEqual([])
  expect(
    recovered({ first: [{ ...failure, state: { ...failure.state, error: "Verification failed" } }], last: [success] }),
  ).toEqual([])
})

test("uncertain effects and background or timed-out results never count as recovery", () => {
  if (failure.state.status !== "error" || success.state.status !== "completed") throw new Error("Expected fixtures")
  expect(recovered({ first: [{ ...failure, state: { ...failure.state, error: "Outcome may have occurred; observe before retrying" } }], last: [success] })).toEqual([])
  expect(recovered({ first: [{ ...failure, state: { ...failure.state, metadata: { phase: "mutation", reason: "target-changed" } } }], last: [success] })).toEqual([])
  for (const metadata of [{ timeout: true }, { job_id: "still-running" }, { exit: 1 }]) {
    expect(recovered({ first: [failure], last: [{ ...success, state: { ...success.state, metadata } }] })).toEqual([])
  }
})

test("no changes is neutral after completion, while unresolved operations remain errors", () => {
  if (failure.state.status !== "error") throw new Error("Expected failure")
  expect(
    recovered({
      first: [
        {
          ...failure,
          state: { ...failure.state, error: "No changes to apply: oldString and newString are identical." },
        },
      ],
    }),
  ).toEqual([failure.id])
  expect(recovered({ first: [failure] })).toEqual([])
})

test("synthetic continuation keeps request ownership and a new user request cannot recover older failures", () => {
  const synthetic = { ...user, id: "shell", time: { created: 3 } }
  const parts = {
    first: [failure],
    shell: [
      { id: "text", sessionID: "session", messageID: "shell", type: "text" as const, text: "result", synthetic: true },
    ],
    last: [success],
  }
  expect(
    recovered(
      parts,
      [last, synthetic, first, user].map((message) =>
        message.id === "last" ? { ...last, parentID: "shell" } : message,
      ),
    ),
  ).toEqual([failure.id])
  expect(
    recovered({ first: [failure], last: [success] }, [user, first, synthetic, { ...last, parentID: "shell" }]),
  ).toEqual([])
})
