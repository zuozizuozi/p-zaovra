import { expect, test } from "bun:test"
import type { AssistantMessage, Message, ToolPart } from "@zaovra-ai/sdk/v2"
import {
  toolFailureDisposition,
  toolFailureInProgress,
  toolExecutionInterrupted,
  quietToolFailures,
  recoveredToolFailures,
} from "./tool-recovery"

const message: AssistantMessage = {
  id: "msg_error",
  sessionID: "ses_test",
  parentID: "msg_visible_parent",
  turn: "msg_request",
  seq: 3,
  role: "assistant",
  agent: "build",
  modelID: "offline",
  providerID: "fixture",
  mode: "build",
  path: { cwd: "/test", root: "/test" },
  time: { created: 100, completed: 101 },
  finish: "tool-calls",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
}
const report = {
  version: 1 as const,
  sessionID: "ses_test",
  turnID: "msg_request",
  assistantMessageID: "msg_error",
  callID: "call",
  basisSeq: 12,
  status: "recovered" as const,
  reason: "same-operation" as const,
  evidence: { assistantMessageID: "msg_success_off_page", callID: "call", settledSeq: 11 },
}
const failure: ToolPart = {
  type: "tool",
  id: "msg_error:call",
  sessionID: "ses_test",
  messageID: "msg_error",
  callID: "call",
  tool: "edit",
  settledSeq: 7,
  failureDisposition: report,
  state: {
    status: "error",
    input: { path: "app.ts" },
    error: "Could not find oldString",
    time: { start: 100, end: 101 },
  },
}
const input = { message, messages: [message], parts: { [message.id]: [failure] }, working: false }

test("a valid persisted result survives an absent request and success page and mismatched display parent", () => {
  const before = JSON.stringify(input)
  expect(recoveredToolFailures(input)).toEqual([failure])
  expect(quietToolFailures({ ...input, historyComplete: false })).toEqual([failure])
  expect(recoveredToolFailures({ ...input, working: true })).toEqual([failure])
  expect(JSON.stringify(input)).toBe(before)
  expect(failure.state.status).toBe("error")
})

for (const status of ["recovered", "exploratory", "failed", "interrupted", "unknown"] as const)
  test("reads authoritative status " + status, () => {
    const reason = {
      recovered: "same-operation",
      exploratory: "exploratory-miss",
      failed: "tool-error",
      interrupted: "interrupted",
      unknown: "unverified",
    } as const
    const evidence = status === "recovered" || status === "exploratory" ? report.evidence : undefined
    const part = {
      ...failure,
      failureDisposition: JSON.parse(JSON.stringify({ ...report, status, reason: reason[status], evidence })),
    }
    const value = { ...input, parts: { [message.id]: [part] } }
    expect(toolFailureDisposition(message, part)?.status).toBe(status)
    expect(recoveredToolFailures(value)).toEqual(status === "recovered" ? [part] : [])
    expect(quietToolFailures(value)).toEqual(["recovered", "exploratory", "interrupted"].includes(status) ? [part] : [])
    expect(toolExecutionInterrupted(message, part)).toBe(status === "interrupted")
  })

for (const invalid of [
  undefined,
  {},
  { ...report, version: 2 },
  { ...report, sessionID: "ses_other" },
  { ...report, assistantMessageID: "msg_other" },
  { ...report, turnID: "msg_other" },
  { ...report, callID: "other" },
  { ...report, basisSeq: 6 },
  { ...report, basisSeq: -1 },
  { ...report, basisSeq: 2.5 },
  { ...report, status: "green" },
  { ...report, reason: "uncertain", evidence: undefined },
  { ...report, reason: "uncertain" },
  { ...report, evidence: undefined },
  { ...report, evidence: { ...report.evidence, settledSeq: 7 } },
  { ...report, evidence: { ...report.evidence, settledSeq: 13 } },
  { ...report, evidence: { ...report.evidence, assistantMessageID: report.assistantMessageID } },
])
  test("malformed, future or foreign report has no display authority " + JSON.stringify(invalid), () => {
    const part = { ...failure, failureDisposition: invalid }
    expect(toolFailureDisposition(message, part)).toBeUndefined()
    expect(recoveredToolFailures({ ...input, parts: { [message.id]: [part] } })).toEqual([])
  })

test("missing turn/sequence, forked negative sequence and copied part identity preserve the error", () => {
  for (const item of [
    { ...message, turn: undefined },
    { ...message, seq: undefined },
    { ...message, seq: -1 },
  ])
    expect(toolFailureDisposition(item, failure)).toBeUndefined()
  for (const part of [
    { ...failure, sessionID: "ses_other" },
    { ...failure, messageID: "msg_other" },
    { ...failure, settledSeq: undefined },
    { ...failure, settledSeq: 2 },
  ])
    expect(toolFailureDisposition(message, part)).toBeUndefined()
})

test("an old service error and matching prose or metadata never become recovered or interrupted", () => {
  const part: ToolPart = {
    ...failure,
    failureDisposition: undefined,
    state: {
      ...failure.state,
      status: "error",
      input: {},
      error: "Tool execution interrupted",
      time: { start: 1, end: 2 },
      metadata: { failureDisposition: report },
    },
    metadata: { failureDisposition: report },
  }
  expect(toolExecutionInterrupted({ ...message, finish: "interrupted" }, part)).toBe(false)
  expect(recoveredToolFailures({ ...input, parts: { [message.id]: [part] } })).toEqual([])
})

test("working display uses backend activity and durable ownership, never timestamps or display parents", () => {
  expect(toolFailureInProgress({ ...input, working: true })).toBe(true)
  expect(toolFailureInProgress(input)).toBe(false)
  expect(toolFailureInProgress({ ...input, working: true, message: { ...message, turn: undefined } })).toBe(false)
  const other: Message = { ...message, id: "msg_other", turn: "msg_new", seq: 20, time: { created: 0 } }
  expect(toolFailureInProgress({ ...input, working: true, messages: [other, message] })).toBe(false)
  expect(toolFailureInProgress({ ...input, working: true, messages: [{ ...message, finish: "stop" }] })).toBe(false)
  const pending: Message = {
    id: "msg_pending",
    sessionID: message.sessionID,
    role: "user",
    time: { created: 1000 },
    agent: "build",
    model: { modelID: "offline", providerID: "fixture" },
  }
  expect(toolFailureInProgress({ ...input, working: true, messages: [message, pending] })).toBe(true)
  expect(
    toolFailureInProgress({ ...input, working: true, messages: [message, { ...pending, turn: pending.id, seq: 30 }] }),
  ).toBe(false)
})
