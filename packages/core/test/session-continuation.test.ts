import { expect, test } from "bun:test"
import { DateTime } from "effect"
import { SessionOutcome } from "../src/session/outcome"
import { SessionMessage } from "../src/session/message"
import { ModelV2 } from "../src/model"
import { ProviderV2 } from "../src/provider"
import { SessionSchema } from "../src/session/schema"

const time = { created: DateTime.makeUnsafe(1), completed: DateTime.makeUnsafe(2) }
const user = (id: string, text: string): SessionMessage.User => ({
  type: "user",
  id: SessionMessage.ID.make(`msg_${id}`),
  text,
  time,
})
const original = user("original", "实现 CSV 往返；交付 README.md。")
const next = user("next", "继续")
const targets = [
  { path: "/src.js", digest: "source" },
  { path: "/test.js", digest: "assertions" },
]
const assistant: SessionMessage.Assistant = {
  type: "assistant",
  id: SessionMessage.ID.make("msg_answer"),
  time,
  finish: "stop",
  metadata: { verificationEnabled: true },
  agent: "build",
  model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") },
  content: [],
}
const check = (
  id: string,
  exit: number,
  command = "npm test",
  overrides: Record<string, unknown> = {},
): SessionMessage.AssistantTool => ({
  type: "tool",
  id,
  name: "bash",
  time,
  state: {
    status: "completed",
    input: { command, verification_targets: targets.map((target) => target.path) },
    content: [],
    structured: {
      verification: {
        kind: "test",
        command,
        callID: id,
        exit,
        cwd: "/",
        targets,
        assertions: [targets[1]],
        requirements: ["CSV round trips"],
        ...overrides,
      },
    },
  },
})
const review = (message: SessionMessage.User, evidence: string, clauses = [1, 2]): SessionMessage.AssistantTool => ({
  type: "tool",
  id: "review",
  name: "verification_review",
  time,
  state: {
    status: "completed",
    input: {},
    content: [],
    structured: {
      review: {
        userMessageID: message.id,
        unverified: [],
        items: clauses.map((requirement) => ({
          requirement,
          evidence: [evidence],
          status: "verified",
          note: "observed",
        })),
      },
    },
  },
})
const marker: SessionMessage.Synthetic = {
  type: "synthetic",
  id: SessionMessage.ID.make("msg_marker"),
  sessionID: SessionSchema.ID.make("ses_test"),
  text: "Verification closing review: {}",
  time,
}
const result = (messages: SessionMessage.Message[], files = targets) =>
  SessionOutcome.derive(messages, false, undefined, files, [])

test("continue keeps original requirements instead of accepting one green clause", () => {
  const messages = [
    original,
    { ...assistant, content: [check("old", 1)], finish: "error" as const },
    next,
    marker,
    { ...assistant, content: [check("fixed", 0), review(next, "fixed", [1])] },
  ]
  expect(SessionOutcome.requested(messages).clauses).toEqual(["实现 CSV 往返；", "交付 README.md。"])
  expect(result(messages).state).toBe("completed_unverified")
  expect(result(messages).missing.join(" ")).toContain("README")
})

test("continue cannot hide a real failure behind an unrelated green command", () => {
  const messages = [
    original,
    { ...assistant, content: [check("failed", 1)] },
    next,
    marker,
    { ...assistant, content: [check("unrelated", 0, "node unrelated.js"), review(next, "unrelated")] },
  ]
  expect(result(messages).state).toBe("failed")
})

test("unchanged successful revalidation releases old failure across continue", () => {
  const messages = [
    original,
    { ...assistant, content: [check("failed", 1)], finish: "error" as const },
    next,
    marker,
    { ...assistant, content: [check("fixed", 0), review(next, "fixed")] },
  ]
  expect(result(messages).state).toBe("completed_verified")
  expect(result(messages, [{ ...targets[0], digest: "changed" }, targets[1]]).state).toBe("completed_unverified")
})

test("unchanged passing evidence is reusable, but the old review is not the current review", () => {
  const previous = { ...assistant, content: [check("passed", 0), review(original, "passed")] }
  expect(
    result([original, marker, previous, next, marker, { ...assistant, content: [review(next, "passed")] }]).state,
  ).toBe("completed_verified")
  expect(result([original, marker, previous, next, marker, assistant]).state).toBe("completed_unverified")
})

test("an ordinary new request does not inherit another task's failures", () => {
  const fresh = user("fresh", "解释这个函数")
  expect(SessionOutcome.requested([original, next, fresh]).clauses).toEqual([fresh.text])
  expect(result([original, { ...assistant, content: [check("failed", 1)] }, fresh, assistant]).checks).toEqual([])
})

test("multiple continues, Desktop inspect, and exact retry keep the same source", () => {
  for (const text of ["请继续。", "continue", "please resume", SessionOutcome.RECOVERY_PROMPT, original.text]) {
    const messages = [original, next, user("again", text)]
    expect(SessionOutcome.requested(messages)).toMatchObject({
      sourceMessageID: original.id,
      userMessageID: "msg_again",
      clauses: ["实现 CSV 往返；", "交付 README.md。"],
    })
  }
  for (const text of ["新任务：继续按钮改成蓝色", "Explain why the text says continue"]) {
    expect(SessionOutcome.requested([original, user("different", text)]).sourceMessageID).toBe(
      SessionMessage.ID.make("msg_different"),
    )
  }
})

test("explicit substantive continuation appends requirements with stable original IDs", () => {
  const amendment = user("amend", "继续，再增加暂停按钮。")
  const request = SessionOutcome.requested([original, amendment, user("retry", amendment.text), next])
  expect(request.sourceMessageID).toBe(original.id)
  expect(request.clauses).toEqual(["实现 CSV 往返；", "交付 README.md。", "再增加暂停按钮。"])
  expect(
    result([
      original,
      { ...assistant, content: [check("ok", 0)] },
      amendment,
      marker,
      { ...assistant, content: [review(amendment, "ok", [1, 3])] },
    ]).missing.join(" "),
  ).toContain("README")
})

test("an exact quoted withdrawal is traceable and does not renumber remaining requirements", () => {
  const cancellation = user("cancel", "继续，取消要求“交付 README.md。”")
  const request = SessionOutcome.requested([original, cancellation])
  expect(request.entries[1]).toMatchObject({ id: 2, text: "交付 README.md。", withdrawnBy: cancellation.id })
  expect(
    result([
      original,
      { ...assistant, content: [check("ok", 0)] },
      cancellation,
      marker,
      { ...assistant, content: [review(cancellation, "ok", [1])] },
    ]).state,
  ).toBe("completed_verified")
})

test("ambiguous corrections preserve the original requirement rather than silently waiving it", () => {
  const amendment = user("amend", "继续，但不要 README")
  expect(SessionOutcome.requested([original, amendment]).clauses).toContain("交付 README.md。")
  expect(SessionOutcome.requested([original, amendment]).entries.every((entry) => !entry.withdrawnBy)).toBe(true)
})

test("explicit amendment labels retain the source while ordinary new requests remain independent", () => {
  for (const text of ["补充要求：增加暂停按钮。", "追加要求：增加暂停按钮。", "continue, add a pause button."])
    expect(SessionOutcome.requested([original, user("amendment", text)]).sourceMessageID).toBe(original.id)
  for (const text of ["新任务：交付新的 README.md。", "解释如何增加暂停按钮。"])
    expect(SessionOutcome.requested([original, user("new", text)]).sourceMessageID).toBe(SessionMessage.ID.make("msg_new"))
})

test("changed attachments are a new request, not an exact retry", () => {
  const changed = { ...user("changed", original.text), files: [{ uri: "file:///new.txt", mime: "text/plain" }] }
  expect(SessionOutcome.requested([original, changed]).sourceMessageID).toBe(changed.id)
})

test("continuation still requires a new review when the prior drain never reached closing", () => {
  expect(result([original, { ...assistant, content: [check("passed", 0)] }, next, assistant]).state).toBe(
    "completed_unverified",
  )
})

test("changing an originally failed assertion after continue cannot certify the original requirement", () => {
  const changed = [{ ...targets[0] }, { ...targets[1], digest: "weakened" }]
  const green = check("edited", 0, "npm test", { targets: changed, assertions: [changed[1]] })
  const outcome = result(
    [
      original,
      { ...assistant, content: [check("failed", 1)] },
      next,
      marker,
      { ...assistant, content: [green, review(next, "edited")] },
    ],
    changed,
  )
  expect(outcome.state).toBe("completed_unverified")
  expect(outcome.missing.join(" ")).toContain("original requirement not reverified")
})

test("unknown old tool effects remain unknown after a prose claim of success", () => {
  const pending: SessionMessage.AssistantTool = {
    type: "tool",
    id: "unknown",
    name: "bash",
    time,
    state: { status: "running", input: { command: "side-effect" }, structured: {}, content: [] },
  }
  expect(result([original, { ...assistant, content: [pending] }, next, assistant])).toMatchObject({
    state: "interrupted",
    outcomeUnknown: true,
  })
})

test("a repaired original assertion is not revived when later tests are extended", () => {
  const changed = [{ ...targets[0] }, { ...targets[1], digest: "extended" }]
  const extended = check("extended", 0, "npm test", { targets: changed, assertions: [changed[1]] })
  const again = user("again", "继续")
  expect(
    result(
      [
        original,
        { ...assistant, content: [check("failed", 1)] },
        next,
        { ...assistant, content: [check("repaired", 0)] },
        again,
        marker,
        { ...assistant, content: [extended, review(again, "extended")] },
      ],
      changed,
    ).state,
  ).toBe("completed_verified")
})

test("rejected and timed-out verification stays unverified until appropriate revalidation", () => {
  for (const execution of ["not-run", "invalid-report", "timeout"]) {
    const failed = check("incomplete", -1, "npm test", { execution })
    const messages = [
      original,
      { ...assistant, content: [failed] },
      next,
      marker,
      { ...assistant, content: [review(next, "incomplete")] },
    ]
    expect(result(messages).state).toBe("completed_unverified")
    expect(result([...messages, { ...assistant, content: [check("rerun", 0), review(next, "rerun")] }]).state).toBe(
      "completed_verified",
    )
  }
})
