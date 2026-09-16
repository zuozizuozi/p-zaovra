import { expect, test } from "bun:test"
import { DateTime } from "effect"
import { ModelV2 } from "@zaovra-ai/core/model"
import { ProviderV2 } from "@zaovra-ai/core/provider"
import { SessionOutcome } from "@zaovra-ai/core/session/outcome"
import { SessionMessage } from "@zaovra-ai/core/session/message"

const assistant: SessionMessage.Assistant = {
  id: SessionMessage.ID.make("msg_result"),
  type: "assistant",
  agent: "build",
  model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") },
  content: [],
  finish: "stop",
  time: { created: DateTime.makeUnsafe(1), completed: DateTime.makeUnsafe(2) },
}

test("live background shells do not block completion, but lost ownership remains unknown", () => {
  const shell: SessionMessage.Shell = {
    id: SessionMessage.ID.make("msg_preview"),
    type: "shell",
    callID: "preview",
    command: "preview",
    output: "",
    time: { created: DateTime.makeUnsafe(1) },
  }
  const messages = [shell, assistant]
  expect(SessionOutcome.derive(messages, false, undefined, [], [], new Set([shell.id]))).toMatchObject({
    state: "completed_unverified",
    outcomeUnknown: false,
  })
  expect(SessionOutcome.derive(messages, false, undefined, [], [], new Set(["another-preview"]))).toMatchObject({
    state: "interrupted",
    outcomeUnknown: true,
  })
  expect(SessionOutcome.derive(messages, false)).toMatchObject({ state: "interrupted", outcomeUnknown: true })
})
test("a normal model stop does not claim engineering verification", () => {
  expect(SessionOutcome.derive([assistant], false).state).toBe("completed_unverified")
  expect(SessionOutcome.derive([assistant], true).state).toBe("running")
  expect(SessionOutcome.derive([{ ...assistant, time: { created: DateTime.makeUnsafe(1) } }], false)).toMatchObject({
    state: "interrupted",
    outcomeUnknown: true,
  })
})
test("checks are tied to the current snapshot, and later failure overrides earlier success", () => {
  const tools: SessionMessage.AssistantTool[] = ["build", "test", "lint"].map((kind) => ({
    id: kind,
    type: "tool",
    name: "bash",
    time: { created: DateTime.makeUnsafe(1), completed: DateTime.makeUnsafe(2) },
    state: {
      status: "completed",
      input: {},
      content: [],
      structured: { verification: { kind, command: `bun run ${kind}`, exit: 0, snapshot: "tree_a", callID: kind } },
    },
  }))
  const completed = { ...assistant, content: tools }
  expect(SessionOutcome.derive([completed], false, "tree_a").state).toBe("completed_verified")
  expect(SessionOutcome.derive([completed], false, "tree_b").state).toBe("completed_unverified")
  const failed: SessionMessage.AssistantTool = {
    ...tools[0],
    id: "build_again",
    state: {
      status: "completed",
      input: {},
      content: [],
      structured: { verification: { kind: "build", command: "bun run build", exit: -1, callID: "build_again" } },
    },
  }
  expect(SessionOutcome.derive([{ ...completed, content: [...tools, failed] }], false, "tree_a").state).toBe("failed")
})

test("a later errored verification invalidates an earlier successful check", () => {
  const previous: SessionMessage.AssistantTool = {
    id: "old",
    time: { created: DateTime.makeUnsafe(1), completed: DateTime.makeUnsafe(2) },
    type: "tool",
    name: "bash",
    state: {
      status: "completed",
      input: {},
      content: [],
      structured: {
        verification: { kind: "test", command: "bun test", exit: 0, snapshot: "tree", callID: "old" },
      },
    },
  }
  const failed: SessionMessage.AssistantTool = {
    id: "new",
    time: { created: DateTime.makeUnsafe(3), completed: DateTime.makeUnsafe(4) },
    type: "tool",
    name: "bash",
    state: {
      status: "error",
      input: { command: "bun test" },
      content: [],
      structured: {},
      error: { type: "unknown", message: "Interrupted" },
    },
  }
  expect(SessionOutcome.derive([{ ...assistant, content: [previous, failed] }], false, "tree")).toMatchObject({
    state: "failed",
    checks: [{ kind: "test", exit: -1, callID: "new" }],
  })
})

test("HTML acceptance binds syntax, startup and interaction to the same current artifact", () => {
  const target = { path: "C:/desktop/game.html", digest: "game-v1" }
  const checks: SessionMessage.AssistantTool[] = ["syntax", "smoke", "interaction"].map((kind) => ({
    id: kind,
    type: "tool",
    name: "bash",
    time: { created: DateTime.makeUnsafe(1), completed: DateTime.makeUnsafe(2) },
    state: {
      status: "completed",
      input: {},
      content: [],
      structured: {
        verification: {
          kind,
          command: `check-${kind}`,
          exit: 0,
          callID: kind,
          targets: [target],
        },
      },
    },
  }))
  expect(
    SessionOutcome.derive([{ ...assistant, content: checks.slice(0, 2) }], false, undefined, [target], []).state,
  ).toBe("completed_unverified")
  expect(SessionOutcome.derive([{ ...assistant, content: checks }], false, undefined, [target], []).state).toBe(
    "completed_verified",
  )
  const preview: SessionMessage.Shell = {
    id: SessionMessage.ID.make("msg_preview"),
    type: "shell",
    callID: "preview",
    command: "preview",
    output: "",
    time: { created: DateTime.makeUnsafe(1) },
  }
  expect(
    SessionOutcome.derive(
      [preview, { ...assistant, content: checks }],
      false,
      undefined,
      [target],
      [],
      new Set([preview.id]),
    ).state,
  ).toBe("completed_verified")
  expect(
    SessionOutcome.derive([preview, { ...assistant, content: checks }], false, undefined, [target], []).state,
  ).toBe("interrupted")
  expect(
    SessionOutcome.derive([{ ...assistant, content: checks }], false, undefined, [{ ...target, digest: "changed" }], [])
      .state,
  ).toBe("completed_unverified")
  expect(SessionOutcome.derive([{ ...assistant, content: checks }], false, "unrelated-project", [], []).state).toBe(
    "completed_unverified",
  )
})

test("one successful test cannot hide another failing test command", () => {
  const content: SessionMessage.AssistantTool[] = [1, 0].map((exit, index) => ({
    id: String(index),
    type: "tool",
    name: "bash",
    time: { created: DateTime.makeUnsafe(1), completed: DateTime.makeUnsafe(2) },
    state: {
      status: "completed",
      input: {},
      content: [],
      structured: {
        verification: {
          kind: "test",
          command: `test-${index}`,
          exit,
          callID: String(index),
          snapshot: "tree",
        },
      },
    },
  }))
  expect(SessionOutcome.derive([{ ...assistant, content }], false, "tree", [], ["test"]).state).toBe("failed")
})

test("changed shell arguments do not reset failed recovery; inspection does", () => {
  const content: SessionMessage.AssistantTool[] = [1, 2, 3, 4].map((index) => ({
    id: String(index),
    type: "tool",
    name: "bash",
    time: { created: DateTime.makeUnsafe(1), completed: DateTime.makeUnsafe(2) },
    state: { status: "completed", input: { command: `variation-${index}` }, content: [], structured: { exit: 1 } },
  }))
  expect(SessionOutcome.recoveryFailures([{ ...assistant, content }])).toBe(4)
  const inspect = {
    ...content[0],
    name: "read",
    state: { status: "completed" as const, input: {}, content: [], structured: {} },
  }
  expect(SessionOutcome.recoveryFailures([{ ...assistant, content: [...content, inspect] }])).toBe(0)
})
