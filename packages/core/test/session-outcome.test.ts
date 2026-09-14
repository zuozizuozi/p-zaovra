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
