/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { createHash } from "node:crypto"
import type { Zaovra, SessionsHistoryOutput, SessionsPromptOutput } from "@zaovra-ai/client"
import { SessionEvent } from "@zaovra-ai/schema/session-event"
import { Option, Schema } from "effect"

type Admission = Pick<SessionsPromptOutput, "id" | "sessionID" | "admittedSeq">
type Event = SessionsHistoryOutput["data"][number]
type Reference = { id: string; seq: number; type: string; version: number; digest: string }
type Values = Record<string, number | null>
type Request = {
  id: string
  purpose: "execution" | "summary" | "unknown"
  started: boolean
  events: string[]
  usage: Array<{ eventID: string; observedInclusive: Values }>
}
type Attempt = {
  id: string
  requestID: string
  phases: Array<{ eventID: string; phase: "start" | "headers" | "failed"; status: number | null }>
  usage: "unknown"
}
type Settlement = {
  id: string
  kind: "step" | "compaction"
  started: boolean
  ended: string[]
  failed: string[]
  observations: Array<{
    eventID: string
    reported: boolean | null
    requestPerformed: boolean | null
    observedBreakdown: Values
    axisPresence: "unknown"
  }>
}

export type HistoryDiagnostics = {
  admission: Admission
  cut: number
  scope: "session-prefix-not-per-admission-billing"
  coverage: {
    status: "complete-through-cut" | "unknown"
    reason: string
    pages: number
    lastSeq: number | null
    replayed: number
    admitted: boolean
    promoted: boolean
  }
  billing: { status: "unknown"; total: null; reserve: "retain"; reason: "no-complete-per-attempt-raw-usage" }
  events: Reference[]
  requests: Request[]
  attempts: Attempt[]
  settlements: Settlement[]
  unknown: string[]
}

/** Collect a bounded durable prefix. Observations are never a complete cost ledger. */
export async function collectHistory(input: {
  client: ReturnType<typeof Zaovra.make>
  admission: Admission
  cut: number
  maxPages?: number
  pageSize?: number
  requestTimeoutMs?: number
}): Promise<HistoryDiagnostics> {
  const report: HistoryDiagnostics = {
    admission: {
      id: input.admission.id,
      sessionID: input.admission.sessionID,
      admittedSeq: input.admission.admittedSeq,
    },
    cut: input.cut,
    scope: "session-prefix-not-per-admission-billing",
    coverage: {
      status: "unknown",
      reason: "not-collected",
      pages: 0,
      lastSeq: null,
      replayed: 0,
      admitted: false,
      promoted: false,
    },
    billing: { status: "unknown", total: null, reserve: "retain", reason: "no-complete-per-attempt-raw-usage" },
    events: [],
    requests: [],
    attempts: [],
    settlements: [],
    unknown: [],
  }
  const maxPages = input.maxPages ?? 20
  const pageSize = input.pageSize ?? 100
  const timeout = input.requestTimeoutMs ?? 2_000
  if (
    !integer(maxPages, 1, 100) ||
    !integer(pageSize, 1, 100) ||
    !integer(timeout, 1, 30_000) ||
    !identifier(input.admission.id) ||
    !identifier(input.admission.sessionID) ||
    !integer(input.admission.admittedSeq, 1) ||
    !integer(input.cut, input.admission.admittedSeq)
  ) {
    report.coverage.reason = "invalid-input-or-bounds"
    return report
  }
  const byID = new Map<string, Reference>()
  const bySeq = new Map<number, string>()
  const requests = new Map<string, Request>()
  const attempts = new Map<string, Attempt>()
  const settlements = new Map<string, Settlement>()
  const definitions = new Map(
    SessionEvent.DurableDefinitions.map((definition) => [definition.type as string, definition]),
  )
  let after = -1
  let finished = false
  try {
    for (let index = 0; index < maxPages; index++) {
      report.coverage.pages++
      const page = await readPage(input.client, input.admission.sessionID, after, pageSize, timeout)
      if (!page || !Array.isArray(page.data) || page.data.length > pageSize || typeof page.hasMore !== "boolean")
        throw new HistoryError("invalid-history-page")
      let previous = -1
      let crossed = false
      let progress = after
      for (const event of page.data) {
        if (
          !event ||
          !identifier(event.id) ||
          !event.id.startsWith("evt_") ||
          !event.durable ||
          event.durable.aggregateID !== input.admission.sessionID ||
          !integer(event.durable.seq) ||
          !event.data ||
          event.data.sessionID !== input.admission.sessionID
        )
          throw new HistoryError("invalid-event-envelope")
        const seq = event.durable.seq
        if (seq <= previous) throw new HistoryError("page-not-strictly-ordered")
        previous = seq
        if (seq > input.cut) {
          crossed = true
          continue
        }
        const definition = definitions.get(event.type)
        if (!definition || event.durable.version !== definition.durable?.version)
          throw new HistoryError("unsupported-event-version")
        if (Option.isNone(Schema.decodeUnknownOption(definition.data)(event.data)))
          throw new HistoryError("invalid-event-data")
        const digest = createHash("sha256")
          .update(JSON.stringify(canonical(event)))
          .digest("hex")
        const existing = byID.get(event.id)
        if (existing) {
          if (existing.seq !== seq || existing.digest !== digest) throw new HistoryError("event-replay-conflict")
          report.coverage.replayed++
          continue
        }
        if (bySeq.has(seq)) throw new HistoryError("sequence-identity-conflict")
        if (seq <= after) throw new HistoryError("unseen-backward-event")
        const ref = { id: event.id, seq, type: event.type, version: event.durable.version, digest }
        byID.set(event.id, ref)
        bySeq.set(seq, event.id)
        report.events.push(ref)
        report.coverage.lastSeq = seq
        progress = seq
        if (event.type === "session.next.prompt.admitted" && event.data.messageID === input.admission.id) {
          if (seq !== input.admission.admittedSeq || report.coverage.admitted)
            throw new HistoryError("admission-conflict")
          report.coverage.admitted = true
        }
        if (event.type === "session.next.prompted" && event.data.messageID === input.admission.id) {
          if (seq <= input.admission.admittedSeq || report.coverage.promoted)
            throw new HistoryError("promotion-conflict")
          report.coverage.promoted = true
        }
        if (event.type === "session.next.prompt.cancelled" && event.data.messageID === input.admission.id)
          report.unknown.push("admission-cancelled")
        project(event, report, requests, attempts, settlements)
      }
      if (crossed || !page.hasMore) {
        finished = true
        break
      }
      if (progress <= after) throw new HistoryError("pagination-no-progress")
      after = progress
    }
    if (!finished) throw new HistoryError("page-limit")
    if (!report.coverage.admitted || !report.coverage.promoted) throw new HistoryError("admission-or-promotion-missing")
    report.coverage.status = "complete-through-cut"
    report.coverage.reason = "bounded-prefix-collected-not-a-quiescence-proof"
  } catch (error) {
    report.coverage.reason = error instanceof HistoryError ? error.message : "history-request-or-shape-failed"
  }
  for (const request of requests.values()) {
    if (!request.started) report.unknown.push("logical-request-start-missing")
    if (!request.usage.length) report.unknown.push("logical-request-usage-missing")
    if (!Array.from(attempts.values()).some((attempt) => attempt.requestID === request.id))
      report.unknown.push("physical-attempt-coverage-missing")
  }
  for (const attempt of attempts.values()) {
    if (!attempt.phases.some((phase) => phase.phase === "start")) report.unknown.push("attempt-start-missing")
  }
  for (const settlement of settlements.values()) {
    if (!settlement.started) report.unknown.push("settlement-start-missing")
    if (!settlement.ended.length && !settlement.failed.length) report.unknown.push("settlement-terminal-missing")
    if (settlement.ended.length > 1 || settlement.failed.length > 1) report.unknown.push("multiple-settlement-events")
  }
  report.requests = Array.from(requests.values())
  report.attempts = Array.from(attempts.values())
  report.settlements = Array.from(settlements.values())
  report.unknown = [
    ...new Set([
      ...report.unknown,
      "per-attempt-usage-and-axis-presence-unproven",
      "admission-billing-attribution-unproven",
    ]),
  ]
  return report
}

function project(
  event: Event,
  report: HistoryDiagnostics,
  requests: Map<string, Request>,
  attempts: Map<string, Attempt>,
  settlements: Map<string, Settlement>,
) {
  const data = event.data
  if (event.type === "session.next.quality.progress" && event.data.category === "cache") {
    const details = event.data.details
    if (!record(details) || !identifier(details.requestID)) {
      report.unknown.push("invalid-cache-diagnostic")
      return
    }
    const request = requests.get(details.requestID) ?? {
      id: details.requestID,
      purpose: "unknown",
      started: false,
      events: [],
      usage: [],
    }
    requests.set(details.requestID, request)
    request.events.push(event.id)
    if (details.phase === "request") {
      if (request.started) report.unknown.push("duplicate-logical-request-start")
      request.started = true
      request.purpose = details.purpose === "execution" || details.purpose === "summary" ? details.purpose : "unknown"
      return
    }
    if (details.phase === "usage") {
      request.usage.push({
        eventID: event.id,
        observedInclusive: values(details, ["input", "output", "hit", "reasoning", "miss", "visible", "total"]),
      })
      return
    }
    if (details.phase !== "attempt" || !record(details.attempt)) {
      report.unknown.push("unknown-cache-phase")
      return
    }
    const value = details.attempt
    if (!identifier(value.id) || !["start", "headers", "failed"].includes(String(value.phase))) {
      report.unknown.push("invalid-attempt-diagnostic")
      return
    }
    const attempt: Attempt = attempts.get(value.id) ?? {
      id: value.id,
      requestID: request.id,
      phases: [],
      usage: "unknown",
    }
    if (attempt.requestID !== request.id) throw new HistoryError("attempt-request-conflict")
    attempts.set(value.id, attempt)
    if (attempt.phases.some((phase) => phase.phase === value.phase)) report.unknown.push("duplicate-attempt-phase")
    attempt.phases.push({
      eventID: event.id,
      phase: value.phase as "start" | "headers" | "failed",
      status: integer(value.status, 100, 599) ? value.status : null,
    })
    return
  }
  if (!event.type.startsWith("session.next.step.") && !event.type.startsWith("session.next.compaction.")) return
  const kind = event.type.startsWith("session.next.step.") ? "step" : "compaction"
  const id = "assistantMessageID" in data ? data.assistantMessageID : "messageID" in data ? data.messageID : undefined
  if (!identifier(id)) throw new HistoryError("settlement-identity-missing")
  const key = `${kind}:${id}`
  const settlement = settlements.get(key) ?? { id, kind, started: false, ended: [], failed: [], observations: [] }
  settlements.set(key, settlement)
  if (event.type.endsWith(".started")) {
    settlement.started = true
    return
  }
  if (event.type.endsWith(".ended")) settlement.ended.push(event.id)
  if (event.type.endsWith(".failed")) settlement.failed.push(event.id)
  const usage = "usage" in data && record(data.usage) ? data.usage : undefined
  const tokens = "tokens" in data ? data.tokens : usage?.tokens
  const reported = "usageReported" in data ? data.usageReported : usage?.reported
  const performed = "requestPerformed" in data ? data.requestPerformed : undefined
  const tokenRecord: Record<string, unknown> = record(tokens) ? tokens : {}
  const cache = record(tokenRecord.cache) ? tokenRecord.cache : {}
  settlement.observations.push({
    eventID: event.id,
    reported: typeof reported === "boolean" ? reported : null,
    requestPerformed: typeof performed === "boolean" ? performed : null,
    axisPresence: "unknown",
    observedBreakdown: {
      ...values(tokenRecord, ["input", "output", "reasoning"]),
      cacheRead: numeric(cache.read),
      cacheWrite: numeric(cache.write),
    },
  })
}

class HistoryError extends Error {}

function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max
}
function numeric(value: unknown) {
  return integer(value) ? value : null
}
function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,200}$/.test(value)
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
function values(value: Record<string, unknown>, keys: string[]): Values {
  return Object.fromEntries(keys.map((key) => [key, numeric(value[key])]))
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (record(value))
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    )
  return value
}
async function readPage(
  client: ReturnType<typeof Zaovra.make>,
  sessionID: string,
  after: number,
  limit: number,
  timeout: number,
) {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      client.sessions.history({ sessionID, ...(after < 0 ? {} : { after }), limit }, { signal: controller.signal }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new HistoryError("history-timeout"))
        }, timeout)
      }),
    ])
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}
