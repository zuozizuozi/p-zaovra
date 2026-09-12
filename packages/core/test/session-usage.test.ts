import { expect, test } from "bun:test"
import { DateTime, Effect } from "effect"
import { SessionUsageQuery } from "@zaovra-ai/core/session/usage"
import { usageTokens, usageReported } from "@zaovra-ai/core/session/usage-tokens"
import { Usage } from "@zaovra-ai/llm"
import { AppNodeBuilder } from "@zaovra-ai/core/effect/app-node-builder"
import { LayerNode } from "@zaovra-ai/core/effect/layer-node"
import { Database } from "@zaovra-ai/core/database/database"
import { EventV2 } from "@zaovra-ai/core/event"
import { SessionEvent } from "@zaovra-ai/schema/session-event"
import { Session } from "@zaovra-ai/schema/session"
import { SessionMessage } from "@zaovra-ai/schema/session-message"
import { Model } from "@zaovra-ai/schema/model"
import { Provider } from "@zaovra-ai/schema/provider"
import { testEffect } from "./lib/effect"

const tokens = { input: 100, output: 20, reasoning: 5, cache: { read: 30, write: 10 } }
const row = (type: string, seq: number, data: Record<string, unknown> = {}) => ({
  aggregate_id: "ses_usage",
  seq,
  type,
  data: { sessionID: "ses_usage", assistantMessageID: "msg_one", timestamp: seq, ...data },
})
const start = (seq: number, id: string, provider = "openai", inputSequence = 1) =>
  row("session.next.step.started.1", seq, {
    assistantMessageID: id,
    model: { id: "test", providerID: provider },
    agent: "build",
    inputSequence,
  })
const end = (seq: number, id: string, data: Record<string, unknown> = {}) =>
  row("session.next.step.ended.2", seq, {
    assistantMessageID: id,
    finish: "stop",
    cost: 0,
    tokens,
    usageReported: true,
    ...data,
  })

test("one user turn sums tool continuations, separates sources and deduplicates settlements", () => {
  const last = end(6, "msg_three")
  const result = SessionUsageQuery.summarize([
    start(1, "msg_one"),
    end(2, "msg_one"),
    start(3, "msg_two"),
    end(4, "msg_two"),
    start(5, "msg_three", "zaovra-pool", 2),
    last,
    last,
  ])
  expect(result.total.total).toBe(495)
  expect(result.own.total).toBe(330)
  expect(result.official.total).toBe(165)
  expect(result.lastTurn?.total).toBe(165)
  expect(result.total.calls).toBe(3)
  expect(
    SessionUsageQuery.summarize([start(1, "msg_one"), end(2, "msg_one"), start(3, "msg_two"), end(4, "msg_two")])
      .lastTurn?.total,
  ).toBe(330)
})

test("missing usage, interrupted calls and synthetic delegation are not represented as free calls", () => {
  const result = SessionUsageQuery.summarize([
    start(1, "msg_one"),
    end(2, "msg_one", { usageReported: false }),
    start(3, "msg_two"),
    row("session.next.step.failed.2", 4, { assistantMessageID: "msg_two" }),
    start(5, "msg_three"),
    end(6, "msg_three", { requestPerformed: false }),
  ])
  expect(result.total.calls).toBe(2)
  expect(result.total.unreported).toBe(2)
  expect(result.total.total).toBe(165)
  expect(result.billing).toBe("unavailable")
})

test("advancing context inputSequence during tool execution does not split a user turn", () => {
  const result = SessionUsageQuery.summarize([
    row("session.next.prompted.1", 1),
    start(2, "msg_one", "openai", 1),
    end(3, "msg_one"),
    start(4, "msg_two", "openai", 3),
    end(5, "msg_two"),
  ])
  expect(result.lastTurn?.total).toBe(330)
  expect(result.lastTurn?.calls).toBe(2)
})

test("compaction usage belongs to its conversation and preceding user turn", () => {
  const result = SessionUsageQuery.summarize([
    start(1, "msg_one"),
    end(2, "msg_one"),
    row("session.next.compaction.ended.1", 3, {
      messageID: "msg_compact",
      reason: "auto",
      text: "summary",
      recent: "recent",
      usage: { providerID: "openai", tokens, reported: true },
    }),
  ])
  expect(result.total.total).toBe(330)
  expect(result.lastTurn?.total).toBe(330)
  expect(result.own.calls).toBe(2)
})

test("normalized inclusive usage counts cache and reasoning only once", () => {
  const usage = Usage.from({
    inputTokens: 140,
    nonCachedInputTokens: 100,
    cacheReadInputTokens: 30,
    cacheWriteInputTokens: 10,
    outputTokens: 25,
    reasoningTokens: 5,
  })
  expect(usageTokens(usage)).toEqual(tokens)
  expect(usageReported(usage)).toBe(true)
  expect(usageReported(Usage.from({}))).toBe(false)
})

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node])))
it.effect("queries durable SQLite settlements across conversations and retains deleted-session usage", () =>
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const first = Session.ID.make("ses_usage_db_one")
    const second = Session.ID.make("ses_usage_db_two")
    const timestamp = DateTime.makeUnsafe(1)
    for (const sessionID of [first, second]) {
      const assistantMessageID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID,
        assistantMessageID,
        timestamp,
        agent: "build",
        inputSequence: 1,
        model: { id: Model.ID.make("test"), providerID: Provider.ID.make(sessionID === first ? "openai" : "zaovra") },
      })
      yield* events.publish(SessionEvent.Step.Ended, {
        sessionID,
        assistantMessageID,
        timestamp,
        finish: "stop",
        cost: 0,
        tokens,
        usageReported: true,
      })
    }
    yield* events.publish(SessionEvent.Deleted, { sessionID: first, timestamp })
    expect((yield* SessionUsageQuery.read(first)).total.total).toBe(165)
    const all = yield* SessionUsageQuery.read()
    expect(all.total.total).toBe(330)
    expect(all.official.total).toBe(165)
    expect((yield* SessionUsageQuery.read("ses_new_fork_without_requests")).total.total).toBe(0)
  }),
)
