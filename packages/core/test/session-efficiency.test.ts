import { expect, test } from "bun:test"
import { DateTime } from "effect"
import { ModelV2 } from "@zaovra-ai/core/model"
import { ProviderV2 } from "@zaovra-ai/core/provider"
import { SessionMessage } from "@zaovra-ai/core/session/message"
import { SessionEfficiency } from "@zaovra-ai/core/session/efficiency"
import { SessionSchema } from "@zaovra-ai/core/session/schema"

const time = { created: DateTime.makeUnsafe(1), completed: DateTime.makeUnsafe(2) }
function calls(names: string[]): SessionMessage.Assistant {
  return {
    id: SessionMessage.ID.create(),
    type: "assistant",
    agent: "build",
    time,
    model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") },
    content: names.map((name, index) => ({
      type: "tool",
      id: `call-${index}`,
      name,
      time,
      state: {
        status: "completed",
        input: { command: "node --version", description: `probe ${index}` },
        content: [],
        structured: {},
      },
    })),
  }
}

test("interleaved repeated probes are advisory, preserve history, and ignore labels", () => {
  const history = [calls(["bash", "read", "bash"])]
  const before = JSON.stringify(history)
  expect(SessionEfficiency.repeatedInspection(history)).toEqual([
    { tool: "bash", previousCallID: "call-0", callID: "call-2" },
  ])
  expect(JSON.stringify(history)).toBe(before)
})

test("edits reset probe history and one durable review suppresses further reminders", () => {
  expect(SessionEfficiency.repeatedInspection([calls(["bash", "write", "bash"])])).toEqual([])
  expect(
    SessionEfficiency.repeatedInspection([
      calls(["read", "read"]),
      {
        type: "synthetic",
        id: SessionMessage.ID.create(),
        sessionID: SessionSchema.ID.make("ses_efficiency"),
        time,
        text: "Repeated inspection review: []",
      },
      calls(["read", "read"]),
    ]),
  ).toEqual([])
})
