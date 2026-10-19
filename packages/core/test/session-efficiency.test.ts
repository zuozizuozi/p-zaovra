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

test("O6 efficiency ignores only root observation fields and retains actual inputs", () => {
  const history = (change: Record<string, unknown> = {}): SessionMessage.Assistant => ({
    ...calls([]),
    content: calls(["bash", "bash"]).content.map((part, index) => {
      if (part.type !== "tool" || part.state.status !== "completed") return part
      return {
        ...part,
        state: {
          ...part.state,
          input: {
            command: "printf ok",
            progress_hypothesis: `hypothesis ${index}`,
            progress_expected_evidence: `evidence ${index}`,
            ...(index ? change : {}),
          },
        },
      }
    }),
  })
  expect(SessionEfficiency.repeatedInspection([history()])).toHaveLength(1)
  for (const change of [
    { command: "printf changed" },
    { workdir: "other" },
    { timeout: 123 },
    { environment: { OMP_NUM_THREADS: "1" } },
  ]) {
    expect(SessionEfficiency.repeatedInspection([history(change)])).toEqual([])
  }
})

test("O6 identity retains nested fields and unknown tool semantics", () => {
  expect(SessionEfficiency.fingerprint("bash", { command: "ok", description: "a" })).toBe(
    SessionEfficiency.fingerprint("bash", { description: "b", command: "ok" }),
  )
  expect(SessionEfficiency.fingerprint("custom", { description: "a" })).not.toBe(
    SessionEfficiency.fingerprint("custom", { description: "b" }),
  )
  expect(SessionEfficiency.fingerprint("bash", { environment: { description: "a" } })).not.toBe(
    SessionEfficiency.fingerprint("bash", { environment: { description: "b" } }),
  )
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
