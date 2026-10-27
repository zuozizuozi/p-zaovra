import { expect, test } from "bun:test"
import type { SessionMessage, SessionV2Info } from "@zaovra-ai/sdk/v2/client"
import { adaptSessionMessages } from "@/context/v2-session-adapter"
import { displayTurnOwners } from "@zaovra-ai/session-ui/turn-ownership"

// From support/evidence/2026-10-27-kernel-380-384/k2-minimal-replay.ts.
// Structural fixture only; no real IDs, paths, timestamps or user content.
const session = {
  id: "session",
  projectID: "project",
  agent: "build",
  model: { id: "model", providerID: "provider" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
  title: "fixture",
  location: { directory: "." },
} satisfies SessionV2Info
const raw: SessionMessage[] = [
  { id: "msg_1_human", type: "user", time: { created: 1 }, text: "request one" },
  {
    id: "msg_bash_1",
    type: "shell",
    time: { created: 2, completed: 3 },
    callID: "preview",
    command: "preview",
    output: "",
  },
  {
    id: "msg_2_answer",
    type: "assistant",
    time: { created: 4, completed: 5 },
    agent: "build",
    model: session.model,
    finish: "stop",
    content: [{ type: "text", id: "text", text: "answer one" }],
  },
  { id: "msg_3_human", type: "user", time: { created: 6 }, text: "request two" },
  {
    id: "msg_bash_2",
    type: "shell",
    callID: "preview-two",
    time: { created: 7, completed: 8 },
    command: "preview",
    output: "",
  },
  {
    id: "msg_4_answer",
    type: "assistant",
    time: { created: 9, completed: 10 },
    agent: "build",
    model: session.model,
    finish: "stop",
    content: [{ type: "text", id: "text", text: "answer two" }],
  },
]
const project = (source: SessionMessage[]) => {
  const adapted = adaptSessionMessages(session, source)
  const messages = adapted.map((item) => item.message).toSorted((a, b) => a.id.localeCompare(b.id))
  const parts = new Map(adapted.map((item) => [item.message.id, item.parts]))
  return { messages, owners: displayTurnOwners(messages, (id) => parts.get(id) ?? []) }
}
test("real adapter preserves the kernel shell fixture ownership without mutating ID order", () => {
  const { messages, owners } = project(raw)
  expect(owners.get("msg_bash_1")).toBe("msg_1_human")
  expect(owners.get("msg_bash_2")).toBe("msg_3_human")
  expect(messages.find((m) => m.id === "msg_2_answer")).toMatchObject({ parentID: "msg_bash_1" })
  expect(messages.map((m) => m.id)).toEqual([...messages].map((m) => m.id).sort())
})
test("host completion source overrides a newer human after real adaptation", () => {
  const { owners } = project([
    raw[0],
    raw[2],
    raw[3],
    {
      id: "late",
      type: "synthetic",
      sessionID: session.id,
      text: "background result",
      time: { created: 7 },
      completion: { type: "bash-completion", sourceMessageID: "msg_2_answer", jobID: "job" },
    },
    {
      id: "late-answer",
      type: "assistant",
      agent: "build",
      model: session.model,
      content: [{ type: "text", id: "text", text: "old result" }],
      time: { created: 8, completed: 9 },
    },
  ])
  expect(owners.get("late")).toBe("msg_1_human")
})
