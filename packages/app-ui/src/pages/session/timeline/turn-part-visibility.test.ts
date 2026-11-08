import { expect, test } from "bun:test"
import type { Part, ToolPart } from "@zaovra-ai/sdk/v2"
import { turnPartFoldable } from "./turn-part-visibility"

const tool = (name: string, state: ToolPart["state"]): ToolPart => ({
  id: "part",
  sessionID: "ses",
  messageID: "msg",
  type: "tool",
  callID: "call",
  tool: name,
  state,
})
const ordinary = { answer: false, coveredFailure: false }

test("741 a folded turn keeps unanswered questions, permission requests and unresolved errors visible", () => {
  const question = tool("question", { status: "pending", input: {}, raw: "{}" })
  const permission = tool("bash", {
    status: "running",
    input: {},
    time: { start: 0 },
    metadata: { phase: "permission" },
  })
  const failed = tool("read", { status: "error", input: {}, error: "missing", time: { start: 0, end: 1 } })
  expect(turnPartFoldable(question, ordinary)).toBe(false)
  expect(turnPartFoldable(permission, ordinary)).toBe(false)
  expect(turnPartFoldable(failed, ordinary)).toBe(false)
  expect(turnPartFoldable(failed, { ...ordinary, coveredFailure: true })).toBe(true)
})

test("741 thoughts and intermediate text collapse while the selected final answer remains visible", () => {
  const thought: Part = {
    id: "reason",
    sessionID: "ses",
    messageID: "msg",
    type: "reasoning",
    text: "thought",
    time: { start: 0, end: 1 },
  }
  const text: Part = { id: "text", sessionID: "ses", messageID: "msg", type: "text", text: "answer" }
  expect(turnPartFoldable(thought, ordinary)).toBe(true)
  expect(turnPartFoldable(text, ordinary)).toBe(true)
  expect(turnPartFoldable(text, { ...ordinary, answer: true })).toBe(false)
  expect(turnPartFoldable(undefined, ordinary)).toBe(false)
})
