import { expect, test } from "bun:test"
import { DeliveryContract } from "../src/session/delivery-contract"

const input = {
  observed: true,
  outcomeUnknown: false,
  pending: false,
  turns: 2,
  toolCalls: 11,
  reviewing: true,
  reported: false,
  unreported: 0,
  previousUnreported: 0,
  output: 256,
  needsContinuation: true,
  hard: ["missing file"],
  missing: ["missing file", "unverified scope"],
  spent: 1,
  allowance: 1,
}

const cases: {
  name: string
  change: Partial<typeof input>
  continuing: boolean
  decision: "repair" | "unverified" | "finished"
  reason: string
}[] = [
  {
    name: "256 output, 2 turns, 11 tools, exact allowance",
    change: {},
    continuing: true,
    decision: "repair",
    reason: "one bounded local repair cycle",
  },
  {
    name: "255 output",
    change: { output: 255 },
    continuing: false,
    decision: "unverified",
    reason: "repair budget exhausted",
  },
  {
    name: "3 turns",
    change: { turns: 3 },
    continuing: false,
    decision: "unverified",
    reason: "repair budget exhausted",
  },
  {
    name: "12 tools",
    change: { toolCalls: 12 },
    continuing: false,
    decision: "unverified",
    reason: "repair budget exhausted",
  },
  {
    name: "overspend precedes exhausted",
    change: { spent: 1.01, output: 255 },
    continuing: false,
    decision: "unverified",
    reason: "reported repair usage exceeded estimated allowance; no further requests",
  },
  {
    name: "unknown usage precedes overspend",
    change: { unreported: 1, spent: 1.01 },
    continuing: false,
    decision: "unverified",
    reason: "unknown repair usage; no further allowance",
  },
  {
    name: "unchanged unknown usage",
    change: { unreported: 1, previousUnreported: 1 },
    continuing: true,
    decision: "repair",
    reason: "one bounded local repair cycle",
  },
  {
    name: "pending precedes unknown effects",
    change: { pending: true, outcomeUnknown: true, unreported: 1 },
    continuing: false,
    decision: "unverified",
    reason: "unfinished background jobs; no retry",
  },
  {
    name: "unknown effects precede unknown usage",
    change: { outcomeUnknown: true, unreported: 1 },
    continuing: false,
    decision: "unverified",
    reason: "unknown effects; no retry",
  },
  {
    name: "inspection failure precedes pending",
    change: { observed: false, pending: true, outcomeUnknown: true },
    continuing: false,
    decision: "unverified",
    reason: "host inspection budget exhausted",
  },
  {
    name: "closed gaps report and stop",
    change: { hard: [], needsContinuation: false },
    continuing: false,
    decision: "finished",
    reason: "deterministic hard gaps closed; report remaining scope",
  },
  {
    name: "closed gaps report continuation",
    change: { hard: [] },
    continuing: true,
    decision: "repair",
    reason: "deterministic hard gaps closed; report remaining scope",
  },
  {
    name: "report already used",
    change: { reported: true, hard: [] },
    continuing: false,
    decision: "finished",
    reason: "deterministic hard gaps closed; report remaining scope",
  },
  {
    name: "exhaustion precedes report",
    change: { hard: [], turns: 3 },
    continuing: false,
    decision: "finished",
    reason: "repair budget exhausted",
  },
  {
    name: "old report with hard gaps",
    change: { reported: true },
    continuing: false,
    decision: "unverified",
    reason: "repair budget exhausted or usage unavailable",
  },
  {
    name: "first cycle does not compare repair usage",
    change: { reviewing: false, reported: true, unreported: 1 },
    continuing: true,
    decision: "repair",
    reason: "one bounded local repair cycle",
  },
  // The caller's estimator normally prevents this combination. Extraction must
  // not silently add an over-budget guard to the original continuing predicate.
  {
    name: "overspend with sufficient estimate preserves predicate",
    change: { spent: 1.01 },
    continuing: true,
    decision: "repair",
    reason: "reported repair usage exceeded estimated allowance; no further requests",
  },
]

for (const item of cases)
  test(`delivery decision: ${item.name}`, () => {
    const before = { ...input, ...item.change }
    const frozen = structuredClone(before)
    const result = DeliveryContract.decide(before)
    expect(result).toMatchObject({ continuing: item.continuing, decision: item.decision, reason: item.reason })
    expect(result.report).toBe(before.reviewing && before.hard.length === 0)
    expect(before).toEqual(frozen)
  })

test("delivery decision preserves missing order, deduplication and all failure annotations", () => {
  const result = DeliveryContract.decide({ ...input, observed: false, unreported: 1, spent: 2 })
  expect(result.missing).toEqual([
    "missing file",
    "unverified scope",
    "unverified: host inspection budget exhausted",
    "unverified: repair usage unavailable; allowance remains consumed",
    "unverified: actual repair usage exceeded admission estimate",
    "unverified: bounded repair ended; host inspection budget exhausted",
  ])
})
