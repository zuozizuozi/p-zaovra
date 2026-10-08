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

test("missing cache price retains the known portion and repricing fills exactly that gap", () => {
  const usage = {
    input: 4599,
    output: 20,
    reasoning: 5,
    cacheRead: 4501,
    cacheWrite: 0,
    total: 9125,
    calls: 1,
    unreported: 0,
  }
  const base = {
    input: 2,
    output: 4,
    cache: { read: 0, write: 0 },
    configured: { input: true, output: true, cacheRead: false, cacheWrite: false },
  }
  const partial = SessionUsageQuery.estimateRequest(usage, [base])
  expect(partial.amount).toBeNull()
  expect(partial.pricedAmount).toBeCloseTo(0.009298)
  expect(partial.unpriced).toEqual({ input: 0, output: 0, cacheRead: 4501, cacheWrite: 0 })
  const complete = SessionUsageQuery.estimateRequest(usage, [
    { ...base, cache: { read: 0.2, write: 0 }, configured: { ...base.configured, cacheRead: true } },
  ])
  expect(complete.amount).toBeCloseTo(0.0101982)
  expect(complete.unpriced.cacheRead).toBe(0)
  expect(SessionUsageQuery.estimateRequest({ ...usage, unreported: 1 }, [base]).pricedAmount).toBeCloseTo(
    partial.pricedAmount,
  )
})

test("estimates preserve missing prices, explicit free rates, cache prices and per-request tiers", () => {
  const usage = {
    input: 100,
    output: 20,
    reasoning: 5,
    cacheRead: 30,
    cacheWrite: 10,
    total: 165,
    calls: 1,
    unreported: 0,
  }
  const price = {
    input: 2,
    output: 4,
    cache: { read: 1, write: 3 },
    configured: { input: true, output: true, cacheRead: true, cacheWrite: true },
  }
  expect(SessionUsageQuery.estimateRequest(usage, [price]).amount).toBeCloseTo(0.00036)
  expect(SessionUsageQuery.estimateRequest(usage, []).amount).toBeNull()
  expect(
    SessionUsageQuery.estimateRequest(usage, [{ input: 0, output: 0, cache: { read: 0, write: 0 } }]).priceConfigured,
  ).toBe(false)
  expect(
    SessionUsageQuery.estimateRequest(usage, [{ ...price, input: 0, output: 0, cache: { read: 0, write: 0 } }]).amount,
  ).toBe(0)
  expect(
    SessionUsageQuery.estimateRequest(usage, [{ ...price, configured: { ...price.configured, cacheWrite: false } }])
      .amount,
  ).toBeNull()
  expect(SessionUsageQuery.estimateRequest({ ...usage, unreported: 1 }, [price])).toMatchObject({
    priceConfigured: true,
    amount: null,
  })
  const tiers = [price, { ...price, tier: { type: "context" as const, size: 150 }, input: 10 }]
  expect(SessionUsageQuery.estimateRequest(usage, tiers).amount).toBeCloseTo(0.00036)
  expect(SessionUsageQuery.estimateRequest({ ...usage, input: 111 }, tiers).amount).toBeCloseTo(0.00127)
})

test("mixed models, unknown historical models and price changes use the same deduplicated ledger", () => {
  const price = { input: 2, output: 4, cache: { read: 1, write: 3 } }
  const model = { ...Model.Info.empty(Provider.ID.make("openai"), Model.ID.make("test")), cost: [price] }
  const rows = [
    start(1, "msg_one"),
    end(2, "msg_one"),
    end(2, "msg_one"),
    start(3, "msg_two", "other"),
    end(4, "msg_two"),
    end(5, "msg_old"),
  ]
  const result = SessionUsageQuery.summarize(rows, new Map([["ses_usage", [model]]]))
  expect(result.models).toHaveLength(3)
  expect(result.models[0].tokens.calls).toBe(1)
  expect(result.models[0].estimate).toBeCloseTo(0.00036)
  expect(result.models[1].estimate).toBeNull()
  expect(result.models[2].modelID).toBeNull()
  const repriced = SessionUsageQuery.summarize(
    rows,
    new Map([["ses_usage", [{ ...model, cost: [{ ...price, input: 4 }] }]]]),
  )
  expect(repriced.total).toEqual(result.total)
  expect(repriced.models[0].estimate).toBeCloseTo(0.00056)
})
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
