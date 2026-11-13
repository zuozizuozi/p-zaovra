import { expect, test } from "bun:test"
import { DateTime, Effect } from "effect"
import { EventV2 } from "@zaovra-ai/core/event"
import { SessionMessageUpdater } from "@zaovra-ai/core/session/message-updater"
import { SessionEvent } from "@zaovra-ai/core/session/event"
import { SessionMessage } from "@zaovra-ai/core/session/message"
import { SessionSchema } from "@zaovra-ai/core/session/schema"
import { ModelV2 } from "@zaovra-ai/core/model"
import { ProviderV2 } from "@zaovra-ai/core/provider"
import { Prompt } from "@zaovra-ai/schema/prompt"

const sessionID = SessionSchema.ID.make("ses_turn")
const model = { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") }
const id = (name: string) => SessionMessage.ID.make("msg_" + name)

function project(events: ReadonlyArray<{ type: SessionEvent.Type; data: Record<string, unknown> }>) {
  const state: SessionMessageUpdater.MemoryState = { messages: [] }
  events.forEach((event, seq) =>
    Effect.runSync(
      SessionMessageUpdater.update(SessionMessageUpdater.memory(state), {
        id: EventV2.ID.create(),
        type: event.type,
        durable: { aggregateID: sessionID, seq, version: 1 },
        data: { sessionID, timestamp: DateTime.makeUnsafe(seq + 1), ...event.data },
      } as SessionEvent.Event),
    ),
  )
  return state.messages.map((message) => ({ id: message.id, type: message.type, seq: message.seq, turn: message.turn }))
}

const prompted = (name: string, extra: Record<string, unknown> = {}) => ({
  type: "session.next.prompted" as const,
  data: { messageID: id(name), prompt: Prompt.make({ text: name }), ...extra },
})
const step = (name: string) => ({
  type: "session.next.step.started" as const,
  data: { assistantMessageID: id(name), agent: "build", model },
})
const shell = (name: string) => ({
  type: "session.next.shell.started" as const,
  data: { messageID: id(name), callID: name, command: "echo" },
})

test("every message records its sequence and the user message it was produced for", () => {
  expect(
    project([
      prompted("first"),
      step("a1"),
      shell("job1"),
      step("a2"),
      // A steer promoted mid-turn starts the next turn; steps already recorded keep theirs.
      prompted("steer"),
      step("a3"),
    ]),
  ).toEqual([
    { id: id("first"), type: "user", seq: 0, turn: id("first") },
    { id: id("a1"), type: "assistant", seq: 1, turn: id("first") },
    { id: id("job1"), type: "shell", seq: 2, turn: id("first") },
    { id: id("a2"), type: "assistant", seq: 3, turn: id("first") },
    { id: id("steer"), type: "user", seq: 4, turn: id("steer") },
    { id: id("a3"), type: "assistant", seq: 5, turn: id("steer") },
  ])
})

test("a background completion returns to the turn that launched it, not the newest one", () => {
  const messages = project([
    prompted("first"),
    step("launcher"),
    prompted("second"),
    step("b1"),
    prompted("done", { completion: { type: "bash-completion", sourceMessageID: id("launcher"), jobID: "job" } }),
    step("after"),
  ])
  expect(messages.slice(-2)).toEqual([
    { id: id("done"), type: "synthetic", seq: 4, turn: id("first") },
    { id: id("after"), type: "assistant", seq: 5, turn: id("first") },
  ])
})

test("history without a recorded turn leaves later messages unowned until the next user message", () => {
  const state: SessionMessageUpdater.MemoryState = {
    messages: [
      SessionMessage.Assistant.make({
        id: id("old"),
        type: "assistant",
        agent: "build",
        model,
        content: [],
        time: { created: DateTime.makeUnsafe(1), completed: DateTime.makeUnsafe(2) },
      }),
    ],
  }
  const apply = (seq: number, event: { type: SessionEvent.Type; data: Record<string, unknown> }) =>
    Effect.runSync(
      SessionMessageUpdater.update(SessionMessageUpdater.memory(state), {
        id: EventV2.ID.create(),
        type: event.type,
        durable: { aggregateID: sessionID, seq, version: 1 },
        data: { sessionID, timestamp: DateTime.makeUnsafe(seq + 10), ...event.data },
      } as SessionEvent.Event),
    )
  apply(7, step("continued"))
  apply(8, prompted("next"))
  apply(9, step("owned"))
  expect(state.messages.map((message) => message.turn)).toEqual([undefined, undefined, id("next"), id("next")])
})
