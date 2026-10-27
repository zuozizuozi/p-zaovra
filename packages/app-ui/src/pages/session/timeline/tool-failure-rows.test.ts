import { expect, test } from "bun:test"
import type { Part } from "@zaovra-ai/sdk/v2"
import { TimelineRow } from "./timeline-row"
import { placeToolFailuresAfterAnswer } from "./tool-failure-rows"

test("settled blocking failures follow the answer, while quiet history and live chronology retain identity", () => {
  const failure = new TimelineRow.AssistantPart({
    userMessageID: "user",
    group: { type: "part", key: "failure", ref: { messageID: "assistant", partID: "failure" } },
    previousAssistantPart: false,
  })
  const answer = new TimelineRow.AssistantPart({
    userMessageID: "user",
    group: { type: "part", key: "answer", ref: { messageID: "assistant", partID: "answer" } },
    previousAssistantPart: true,
  })
  const rows = [new TimelineRow.AssistantHeading({ userMessageID: "user" }), failure, answer]
  const part: Part = {
    type: "tool",
    id: "failure",
    messageID: "assistant",
    sessionID: "session",
    callID: "call",
    tool: "read",
    state: { status: "error", input: { filePath: "missing" }, error: "File not found", time: { start: 1, end: 2 } },
  }
  const result = placeToolFailuresAfterAnswer(rows, () => [part], new Set(), true)
  expect(result).toEqual([rows[0], answer, failure])
  expect(result.at(-1)).toBe(failure)
  expect(placeToolFailuresAfterAnswer(rows, () => [part], new Set([part.id]), true)).toBe(rows)
  expect(placeToolFailuresAfterAnswer(rows, () => [part], new Set(), false)).toBe(rows)
  expect(
    placeToolFailuresAfterAnswer(
      rows,
      () => [{ ...part, tool: "question", state: { ...part.state, error: "The user dismissed this question" } }],
      new Set(),
      true,
    ),
  ).toBe(rows)
})
