import { expect, test } from "bun:test"
import { DateTime } from "effect"
import { SessionMessage } from "@zaovra-ai/core/session/message"
import { ToolDisposition } from "@zaovra-ai/core/session/tool-disposition"
import { ModelV2 } from "@zaovra-ai/core/model"
import { ProviderV2 } from "@zaovra-ai/core/provider"
import { Model } from "@zaovra-ai/llm"
import { OpenAICompatibleChat } from "@zaovra-ai/llm/protocols/openai-compatible-chat"
import { toLLMMessages } from "@zaovra-ai/core/session/runner/to-llm-message"

const sessionID = "ses_disposition_cases"
const user = SessionMessage.User.make({
  id: SessionMessage.ID.make("msg_user"),
  type: "user",
  turn: SessionMessage.ID.make("msg_user"),
  seq: 0,
  text: "Fix app.ts",
  time: { created: DateTime.makeUnsafe(1) },
})
const first = SessionMessage.Assistant.make({
  id: SessionMessage.ID.make("msg_first"),
  type: "assistant",
  turn: user.id,
  seq: 1,
  agent: "build",
  model: { id: ModelV2.ID.make("offline"), providerID: ProviderV2.ID.make("fixture") },
  finish: "tool-calls",
  time: { created: DateTime.makeUnsafe(2), completed: DateTime.makeUnsafe(3) },
  content: [],
})
const last = {
  ...first,
  id: SessionMessage.ID.make("msg_last"),
  seq: 4,
  finish: "stop",
  time: { created: DateTime.makeUnsafe(4), completed: DateTime.makeUnsafe(5) },
}
const failure = SessionMessage.AssistantTool.make({
  type: "tool",
  id: "failure",
  name: "edit",
  settledSeq: 3,
  time: { created: DateTime.makeUnsafe(2), completed: DateTime.makeUnsafe(3) },
  state: {
    status: "error",
    input: { path: "app.ts", oldString: "old", newString: "fixed" },
    structured: {},
    content: [],
    error: { type: "unknown", message: "Could not find oldString" },
  },
  failureDisposition: {
    version: 1,
    sessionID,
    turnID: user.id,
    assistantMessageID: first.id,
    callID: "failure",
    basisSeq: 8,
    status: "unknown",
    reason: "invalidated",
  },
})
const success = SessionMessage.AssistantTool.make({
  type: "tool",
  id: "success",
  name: "edit",
  settledSeq: 6,
  time: { created: DateTime.makeUnsafe(4), completed: DateTime.makeUnsafe(5) },
  state: {
    status: "completed",
    input: { path: "app.ts", oldString: " old ", newString: "fixed" },
    structured: {},
    content: [],
  },
})
if (failure.state.status !== "error" || success.state.status !== "completed") throw new Error("Invalid fixtures")
const failed = failure.state
const completed = success.state

function history(before = failure, after = success): SessionMessage.Message[] {
  return [
    user,
    { ...first, content: [before] },
    { ...last, content: [after, { type: "text", id: "final", text: "Done" }] },
  ]
}
function result(messages = history()) {
  return ToolDisposition.classify(sessionID, messages).find((report) => report.assistantMessageID === first.id)
}

test("native exact edit recovery preserves the source error and requires a settled authoritative turn", () => {
  expect(result()).toMatchObject({ status: "recovered", reason: "same-operation" })
  expect(failure.state).toEqual(failed)
  for (const terminal of [
    { ...last, finish: "tool-calls" },
    { ...last, time: { created: last.time.created } },
  ])
    expect(result([user, { ...first, content: [failure] }, { ...terminal, content: [success] }])).toMatchObject({
      status: "unknown",
    })
  expect(
    result([
      user,
      { ...first, content: [failure] },
      { ...last, content: [success, { ...success, id: "pending", state: { status: "pending", input: "" } }] },
    ]),
  ).toMatchObject({ status: "unknown" })
})

test("display reports and durable settlement sequences do not alter provider context", () => {
  const model = Model.make({ id: "offline", provider: "fixture", route: OpenAICompatibleChat.route })
  const original = history().map((message) =>
    message.type !== "assistant"
      ? message
      : {
          ...message,
          content: message.content.map((part) => {
            if (part.type !== "tool") return part
            const { settledSeq, failureDisposition, ...tool } = part
            return tool
          }),
        },
  )
  const recovered = history({ ...failure, failureDisposition: result() })
  expect(toLLMMessages(recovered, model)).toEqual(toLLMMessages(original, model))
  expect(JSON.stringify(toLLMMessages(recovered, model))).toContain("Could not find oldString")
  expect(JSON.stringify(toLLMMessages(recovered, model))).not.toContain("failureDisposition")
})

const rejected: Record<string, SessionMessage.AssistantTool> = {
  target: { ...success, state: { ...completed, input: { ...completed.input, path: "other.ts" } } },
  replacement: { ...success, state: { ...completed, input: { ...completed.input, newString: "unrelated" } } },
  block: { ...success, state: { ...completed, input: { ...completed.input, oldString: "other block" } } },
  replaceAll: { ...success, state: { ...completed, input: { ...completed.input, replaceAll: true } } },
  write: { ...success, name: "write", state: { ...completed, input: { path: "app.ts", content: "fixed" } } },
  earlier: { ...success, settledSeq: 2 },
  unknownSequence: { ...success, settledSeq: undefined },
  formatting: { ...success, state: { ...completed, structured: { formatting: { failed: ["formatter"] } } } },
  diagnostics: {
    ...success,
    state: { ...completed, structured: { applied: [{ resource: "app.ts", lsp: { failed: ["error"] } }] } },
  },
  timeout: { ...success, state: { ...completed, structured: { timeout: true } } },
  background: { ...success, state: { ...completed, structured: { job_id: "active" } } },
  nonzero: { ...success, state: { ...completed, structured: { exit: 1 } } },
  provider: { ...success, provider: { executed: true } },
}
for (const [name, after] of Object.entries(rejected))
  test("does not recover from " + name, () => {
    expect(result(history(failure, after))).toMatchObject({ status: "failed" })
  })

for (const error of [
  "Verification failed",
  "Outcome may have occurred",
  "timeout",
  "partial mutation",
  "permission denied",
  "EACCES",
]) {
  test("keeps protected failure visible: " + error, () => {
    expect(
      result(history({ ...failure, state: { ...failed, error: { type: "unknown", message: error } } })),
    ).toMatchObject({ status: "failed" })
  })
}

test("does not merge agents, user turns or provider call identities", () => {
  expect(
    result([user, { ...first, content: [failure] }, { ...last, agent: "other", content: [success] }]),
  ).toMatchObject({ status: "failed" })
  expect(
    result([
      user,
      { ...first, finish: "stop", content: [failure] },
      { ...last, turn: SessionMessage.ID.make("msg_other"), content: [success] },
    ]),
  ).toMatchObject({ status: "failed" })
  expect(result(history({ ...failure, provider: { executed: true } }))).toMatchObject({ status: "unknown" })
  expect(result([user, { ...first, content: [failure, failure] }, { ...last, content: [success] }])).toMatchObject({
    status: "unknown",
  })
})

test("unknown/future contracts, copied rows and missing request evidence never gain authority", () => {
  expect(
    result(history({ ...failure, failureDisposition: { ...failure.failureDisposition, version: 2 } })),
  ).toBeUndefined()
  expect(
    result(history({ ...failure, failureDisposition: { ...failure.failureDisposition, sessionID: "ses_other" } })),
  ).toBeUndefined()
  expect(result(history({ ...failure, settledSeq: undefined }))).toMatchObject({ status: "unknown" })
  expect(
    result(history().map((message) => (message.id === first.id ? { ...message, seq: -1 } : message))),
  ).toMatchObject({ status: "unknown" })
  expect(result(history().filter((message) => message.type !== "user"))).toMatchObject({ status: "unknown" })
})

test("no changes is neutral, not a recovered edit, only after normal final output", () => {
  const noChange: SessionMessage.AssistantTool = {
    ...failure,
    state: { ...failed, error: { type: "unknown", message: "No changes to apply: same text" } },
  }
  expect(result(history(noChange))).toMatchObject({ status: "exploratory", reason: "no-changes" })
  expect(result([user, { ...first, content: [noChange] }, { ...last, finish: "error", content: [] }])).toMatchObject({
    status: "failed",
  })
})

test("Stop requires a user interruption settlement as well as its matching in-flight tool error", () => {
  const interrupted: SessionMessage.AssistantTool = {
    ...failure,
    state: { ...failed, error: { type: "unknown", message: "Tool execution interrupted" } },
  }
  const message = { ...first, finish: "interrupted", content: [interrupted] }
  expect(result([user, message])).toMatchObject({ status: "failed" })
  expect(
    result([
      user,
      { ...message, termination: { category: "interrupted", source: "user", message: "Stopped by user" } },
    ]),
  ).toMatchObject({ status: "failed" })
  expect(
    result([
      user,
      {
        ...message,
        content: [{ ...interrupted, settlement: "interrupted" }],
        termination: { category: "interrupted", source: "user", message: "Stopped by user" },
      },
    ]),
  ).toMatchObject({ status: "interrupted" })
  expect(
    result([
      user,
      { ...message, termination: { category: "interrupted", source: "permission", message: "Permission denied" } },
    ]),
  ).toMatchObject({ status: "failed" })
})

const missing: SessionMessage.AssistantTool = {
  ...failure,
  name: "read",
  state: {
    ...failed,
    input: { filePath: "notes.md" },
    structured: { readFailure: "not_found" },
    error: { type: "unknown", message: "ENOENT" },
  },
}
const written = {
  ...success,
  name: "write",
  state: { ...completed, input: { filePath: "notes.md", content: "new notes" } },
}
const read = { ...success, name: "read", state: { ...completed, input: { filePath: "notes.md" } } }

test("exploratory missing read needs actual same-path same-agent evidence and complete request", () => {
  expect(result(history(missing, written))).toMatchObject({ status: "exploratory" })
  expect(result(history(missing, read))).toMatchObject({ status: "recovered" })
  expect(
    result(history(missing, { ...written, state: { ...written.state, input: { filePath: "elsewhere.md" } } })),
  ).toMatchObject({ status: "failed" })
  const messages = history(missing, written)
  expect(
    result(
      messages.map((message) => (message.id === last.id ? { ...last, agent: "other", content: [written] } : message)),
    ),
  ).toMatchObject({ status: "failed" })
  expect(result([{ ...user, text: "Read notes.md" }, ...messages.slice(1)])).toMatchObject({ status: "failed" })
})

for (const text of [
  "继续",
  "继续：检查 notes.md",
  "追加要求",
  "追加要求：读取 notes.md",
  "Read notes.md",
  "Read the file `notes.md`; do not substitute another source",
]) {
  test("request source cannot be waived after " + text, () => {
    expect(result([{ ...user, text }, ...history(missing, written).slice(1)])?.status).not.toBe("exploratory")
  })
}

test("request amendments, quoted data, invocation and opaque attachments cannot authorize placeholder writes", () => {
  const messages = history(missing, written)
  for (const text of ["notes.md", "Raw data: notes.md", "追加要求：读取 notes.md"]) {
    const prior = { ...user, id: SessionMessage.ID.make("msg_original"), seq: 0, text: "Read notes.md" }
    expect(result([prior, { ...user, seq: 1, text }, ...messages.slice(1)])?.status).not.toBe("exploratory")
  }
  expect(result([{ ...user, invocation: "Read notes.md" }, ...messages.slice(1)])).toMatchObject({ status: "failed" })
  expect(result([{ ...user, agents: [{ name: "build" }] }, ...messages.slice(1)])).toMatchObject({ status: "unknown" })
})
