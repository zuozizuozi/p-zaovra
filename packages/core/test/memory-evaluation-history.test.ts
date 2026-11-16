import { expect, test } from "bun:test"
import { Zaovra } from "@zaovra-ai/client"
import { collectHistory } from "../../../script/evaluation/memory/history"

const admission = { sessionID: "ses_eval", id: "msg_prompt", admittedSeq: 10 }
function event(
  type: string,
  seq: number,
  data: Record<string, unknown> = {},
  version = type === "session.next.step.ended" || type === "session.next.step.failed" ? 2 : 1,
) {
  return {
    id: `evt_${seq}`,
    type,
    durable: { aggregateID: admission.sessionID, seq, version },
    data: { timestamp: 1000 + seq, sessionID: admission.sessionID, ...data },
  }
}
const admitted = event("session.next.prompt.admitted", 10, {
  messageID: admission.id,
  prompt: { text: "PRIVATE PROMPT" },
  delivery: "steer",
})
const promoted = event("session.next.prompted", 15, {
  messageID: admission.id,
  prompt: { text: "PRIVATE PROMPT" },
  delivery: "steer",
})
const cache = (seq: number, details: Record<string, unknown>) =>
  event("session.next.quality.progress", seq, { category: "cache", details })
const started = event("session.next.step.started", 20, {
  assistantMessageID: "msg_assistant",
  agent: "build",
  model: { id: "model", providerID: "local" },
})
const ended = event("session.next.step.ended", 40, {
  assistantMessageID: "msg_assistant",
  finish: "stop",
  cost: 0,
  usageReported: true,
  tokens: { input: 7, output: 3, reasoning: 2, cache: { read: 5, write: 0 } },
})
const failed = event("session.next.step.failed", 45, {
  assistantMessageID: "msg_assistant",
  error: { type: "unknown", message: "PRIVATE ERROR" },
})
const history = [
  admitted,
  promoted,
  started,
  cache(22, {
    phase: "request",
    requestID: "msg_request",
    purpose: "execution",
    body: "PRIVATE BODY",
    headers: { Authorization: "PRIVATE KEY" },
  }),
  cache(24, { phase: "attempt", requestID: "msg_request", attempt: { id: "attempt-1", phase: "start" } }),
  cache(25, { phase: "attempt", requestID: "msg_request", attempt: { id: "attempt-1", phase: "failed" } }),
  cache(26, { phase: "attempt", requestID: "msg_request", attempt: { id: "attempt-2", phase: "start" } }),
  cache(28, {
    phase: "attempt",
    requestID: "msg_request",
    attempt: { id: "attempt-2", phase: "headers", status: 200 },
  }),
  cache(30, {
    phase: "usage",
    requestID: "msg_request",
    input: 12,
    output: 5,
    hit: 5,
    reasoning: 2,
    miss: 7,
    visible: 3,
    total: 17,
  }),
  ended,
  failed,
]

async function fixture(pages?: unknown[], data = history, delay = 0) {
  const reads: URL[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      reads.push(url)
      expect(request.method).toBe("GET")
      expect(url.pathname).toBe(`/api/session/${admission.sessionID}/history`)
      expect(url.searchParams.has("after") ? Number(url.searchParams.get("after")) >= 0 : true).toBe(true)
      if (delay) await Bun.sleep(delay)
      if (pages) return Response.json(pages[reads.length - 1] ?? { data: [], hasMore: false })
      const after = Number(url.searchParams.get("after") ?? -1)
      const limit = Number(url.searchParams.get("limit"))
      const remaining = data.filter((item) => item.durable.seq > after)
      return Response.json({ data: remaining.slice(0, limit), hasMore: remaining.length > limit })
    },
  })
  return {
    client: Zaovra.make({ baseUrl: server.url.toString() }),
    reads,
    async [Symbol.asyncDispose]() {
      await server.stop(true)
    },
  }
}

test("generated client collects real pagination with global sequence gaps, no duplicate billing or text retention", async () => {
  await using f = await fixture()
  const result = await collectHistory({ client: f.client, admission, cut: 50, pageSize: 3 })
  expect(result.coverage).toMatchObject({
    status: "complete-through-cut",
    pages: 4,
    lastSeq: 45,
    admitted: true,
    promoted: true,
  })
  expect(f.reads[0].searchParams.has("after")).toBe(false)
  expect(result.events).toHaveLength(11)
  expect(result.attempts).toHaveLength(2)
  expect(result.requests).toHaveLength(1)
  expect(result.settlements).toHaveLength(1)
  expect(result.settlements[0].ended).toEqual([ended.id])
  expect(result.settlements[0].failed).toEqual([failed.id])
  expect(result.attempts.every((item) => item.usage === "unknown")).toBe(true)
  expect(result.billing).toEqual({
    status: "unknown",
    total: null,
    reserve: "retain",
    reason: "no-complete-per-attempt-raw-usage",
  })
  expect(JSON.stringify(result)).not.toContain("PRIVATE")
  expect(JSON.stringify(result)).not.toContain("Authorization")
})

test("exact replay is deduplicated, including object-key order changes", async () => {
  const replay = { data: admitted.data, durable: admitted.durable, type: admitted.type, id: admitted.id }
  await using f = await fixture([
    { data: [admitted], hasMore: true },
    { data: [replay, promoted], hasMore: false },
  ])
  const result = await collectHistory({ client: f.client, admission, cut: 50 })
  expect(result.coverage.status).toBe("complete-through-cut")
  expect(result.coverage.replayed).toBe(1)
  expect(result.events).toHaveLength(2)
})

for (const [name, second, reason] of [
  [
    "changed replay",
    { ...admitted, data: { ...admitted.data, prompt: { text: "different" } } },
    "event-replay-conflict",
  ],
  ["different identity at same seq", { ...admitted, id: "evt_other" }, "sequence-identity-conflict"],
  ["same identity at changed seq", { ...admitted, durable: { ...admitted.durable, seq: 11 } }, "event-replay-conflict"],
] as const)
  test(name, async () => {
    await using f = await fixture([
      { data: [admitted], hasMore: true },
      { data: [second, promoted], hasMore: false },
    ])
    expect((await collectHistory({ client: f.client, admission, cut: 50 })).coverage.reason).toBe(reason)
  })

for (const [name, bad, reason] of [
  [
    "wrong aggregate",
    { ...admitted, durable: { ...admitted.durable, aggregateID: "ses_other" } },
    "invalid-event-envelope",
  ],
  ["wrong data session", { ...admitted, data: { ...admitted.data, sessionID: "ses_other" } }, "invalid-event-envelope"],
  ["missing durable", { ...admitted, durable: undefined }, "invalid-event-envelope"],
  ["unknown version", { ...admitted, durable: { ...admitted.durable, version: 99 } }, "unsupported-event-version"],
  ["unknown event type", { ...admitted, type: "session.next.future" }, "unsupported-event-version"],
  [
    "malformed typed payload",
    { ...admitted, data: { sessionID: admission.sessionID, timestamp: 1 } },
    "invalid-event-data",
  ],
] as const)
  test(name, async () => {
    await using f = await fixture([{ data: [bad, promoted], hasMore: false }])
    expect((await collectHistory({ client: f.client, admission, cut: 50 })).coverage.reason).toBe(reason)
  })

test("page limits, malformed envelopes and nonadvancing replay cannot claim completion", async () => {
  for (const pages of [
    [{ data: [], hasMore: true }],
    [{ data: [promoted, admitted], hasMore: false }],
    [{ data: [admitted] }],
    [
      { data: [admitted], hasMore: true },
      { data: [admitted], hasMore: true },
    ],
  ]) {
    await using f = await fixture(pages)
    expect((await collectHistory({ client: f.client, admission, cut: 50 })).coverage.status).toBe("unknown")
  }
  await using f = await fixture()
  expect(
    (await collectHistory({ client: f.client, admission, cut: 50, maxPages: 1, pageSize: 2 })).coverage.reason,
  ).toBe("page-limit")
  expect(f.reads).toHaveLength(1)
})

test("cut boundary excludes future events without requiring a session event at the global cut", async () => {
  await using f = await fixture()
  const result = await collectHistory({ client: f.client, admission, cut: 16 })
  expect(result.coverage.status).toBe("complete-through-cut")
  expect(result.events.map((item) => item.seq)).toEqual([10, 15])
  expect(result.requests).toEqual([])
})

test("admission sequence and promotion must be this actual input", async () => {
  await using f = await fixture()
  expect(
    (await collectHistory({ client: f.client, admission: { ...admission, admittedSeq: 11 }, cut: 50 })).coverage.reason,
  ).toBe("admission-conflict")
  expect(
    (await collectHistory({ client: f.client, admission: { ...admission, id: "msg_absent" }, cut: 50 })).coverage
      .reason,
  ).toBe("admission-or-promotion-missing")
  expect((await collectHistory({ client: f.client, admission, cut: 10 })).coverage.reason).toBe(
    "admission-or-promotion-missing",
  )
})

test("failed and successful compaction attempts remain separate observations without summing their aliases", async () => {
  const data = [
    admitted,
    promoted,
    event("session.next.compaction.started", 20, { messageID: "msg_summary1", reason: "auto", sourceSequence: 15 }),
    event("session.next.compaction.failed", 22, {
      messageID: "msg_summary1",
      reason: "auto",
      sourceSequence: 15,
      error: { type: "unknown", message: "PRIVATE" },
    }),
    event("session.next.compaction.started", 24, { messageID: "msg_summary2", reason: "auto", sourceSequence: 15 }),
    event("session.next.compaction.ended", 26, {
      messageID: "msg_summary2",
      reason: "auto",
      sourceSequence: 15,
      text: "PRIVATE SUMMARY",
      recent: "PRIVATE RECENT",
      usage: {
        providerID: "local",
        reported: true,
        tokens: { input: 4, output: 2, reasoning: 0, cache: { read: 1, write: 0 } },
      },
    }),
  ]
  await using f = await fixture(undefined, data)
  const result = await collectHistory({ client: f.client, admission, cut: 50 })
  expect(result.coverage.status).toBe("complete-through-cut")
  expect(result.settlements).toHaveLength(2)
  expect(result.settlements[0].observations[0]).toMatchObject({
    reported: null,
    observedBreakdown: { input: null, output: null, reasoning: null, cacheRead: null, cacheWrite: null },
  })
  expect(result.billing.total).toBeNull()
  expect(JSON.stringify(result)).not.toContain("PRIVATE")
})

test("missing cache axes are null and zero-valued Step axes still have unknown presence", async () => {
  await using f = await fixture(undefined, [
    admitted,
    promoted,
    cache(20, { phase: "usage", requestID: "msg_req", output: 0 }),
    ended,
  ])
  const result = await collectHistory({ client: f.client, admission, cut: 50 })
  expect(result.requests[0].usage[0].observedInclusive).toMatchObject({
    input: null,
    output: 0,
    hit: null,
    reasoning: null,
  })
  expect(result.settlements[0].observations[0].axisPresence).toBe("unknown")
  expect(result.unknown).toContain("logical-request-start-missing")
  expect(result.unknown).toContain("physical-attempt-coverage-missing")
})

test("physical attempt cannot be reassigned to another logical request", async () => {
  await using f = await fixture(undefined, [
    admitted,
    promoted,
    cache(20, { phase: "attempt", requestID: "msg_a", attempt: { id: "attempt-1", phase: "start" } }),
    cache(22, { phase: "attempt", requestID: "msg_b", attempt: { id: "attempt-1", phase: "headers" } }),
  ])
  expect((await collectHistory({ client: f.client, admission, cut: 50 })).coverage.reason).toBe(
    "attempt-request-conflict",
  )
})

test("cancelled admission and unterminated started steps are explicitly uncertain", async () => {
  await using f = await fixture(undefined, [
    admitted,
    promoted,
    started,
    event("session.next.prompt.cancelled", 30, { messageID: admission.id }),
  ])
  const result = await collectHistory({ client: f.client, admission, cut: 50 })
  expect(result.unknown).toContain("admission-cancelled")
  expect(result.unknown).toContain("settlement-terminal-missing")
  expect(result.billing.status).toBe("unknown")
})

test("finite request deadline and invalid bounds preserve reserve and never invent a total", async () => {
  await using f = await fixture(undefined, history, 80)
  const result = await collectHistory({ client: f.client, admission, cut: 50, requestTimeoutMs: 10 })
  expect(result.coverage.status).toBe("unknown")
  expect(result.billing.reserve).toBe("retain")
  await using invalid = await fixture()
  expect((await collectHistory({ client: invalid.client, admission, cut: 50, pageSize: 101 })).coverage.reason).toBe(
    "invalid-input-or-bounds",
  )
  expect(invalid.reads).toHaveLength(0)
})

test("known non-provider settlement and unreported zeros are observations, never billable totals", async () => {
  await using f = await fixture(undefined, [
    admitted,
    promoted,
    started,
    event("session.next.step.ended", 40, {
      assistantMessageID: "msg_assistant",
      finish: "stop",
      cost: 0,
      usageReported: false,
      requestPerformed: false,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }),
  ])
  const result = await collectHistory({ client: f.client, admission, cut: 50 })
  expect(result.settlements[0].observations[0]).toMatchObject({
    reported: false,
    requestPerformed: false,
    axisPresence: "unknown",
  })
  expect(result.billing.total).toBeNull()
  expect(result.billing.reserve).toBe("retain")
})

test("same terminal kind repeated and missing physical start remain explicit unknowns", async () => {
  await using f = await fixture(undefined, [
    admitted,
    promoted,
    cache(25, {
      phase: "attempt",
      requestID: "msg_request",
      attempt: { id: "attempt-1", phase: "headers", status: 200 },
    }),
    ended,
    { ...ended, id: "evt_repeat", durable: { ...ended.durable, seq: 41 } },
  ])
  const result = await collectHistory({ client: f.client, admission, cut: 50 })
  expect(result.unknown).toContain("attempt-start-missing")
  expect(result.unknown).toContain("multiple-settlement-events")
  expect(result.settlements).toHaveLength(1)
  expect(result.settlements[0].observations).toHaveLength(2)
})

test("historical step settlement version is not silently decoded with the current version", async () => {
  await using f = await fixture(undefined, [
    admitted,
    promoted,
    { ...ended, durable: { ...ended.durable, version: 1 } },
  ])
  expect((await collectHistory({ client: f.client, admission, cut: 50 })).coverage.reason).toBe(
    "unsupported-event-version",
  )
})

test("invalid event IDs and a new backward event fail closed", async () => {
  await using badID = await fixture([{ data: [{ ...admitted, id: "not-an-event" }], hasMore: false }])
  expect((await collectHistory({ client: badID.client, admission, cut: 50 })).coverage.reason).toBe(
    "invalid-event-envelope",
  )
  await using backward = await fixture([
    { data: [admitted], hasMore: true },
    { data: [event("session.next.prompted", 9, promoted.data)], hasMore: false },
  ])
  expect((await collectHistory({ client: backward.client, admission, cut: 50 })).coverage.reason).toBe(
    "unseen-backward-event",
  )
})
