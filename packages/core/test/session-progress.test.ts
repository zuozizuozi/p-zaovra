import { expect, test } from "bun:test"
import { ConfigExperimental } from "../src/config/experimental"
import { SessionProgress } from "../src/session/progress"

test("Q1 active accounting excludes idle and never charges a restart gap", () => {
  const first = SessionProgress.advance(undefined, { now: 100, active: 0, request: "one" })
  const checkpoint = SessionProgress.advance(first, { now: 150, active: 50, request: "one" })
  const restarted = SessionProgress.advance(checkpoint, { now: 10000, active: 0, request: "one" })
  expect(restarted.activeMs).toBe(50)
  expect(restarted.requestStarted).toBe(100)
  const next = SessionProgress.advance(restarted, { now: 10100, active: 100, request: "two" })
  expect(next.activeMs).toBe(150)
  expect(next.requestStarted).toBe(10100)
})

test("Q1 facts retain unknown usage and only explicit budgets produce remaining values", () => {
  const input = {
    now: 150,
    state: { activeMs: 50, request: "one", requestStarted: 100 },
    turns: 4,
    step: 2,
    limit: 150,
    tokens: 800,
    unreported: 1,
  }
  const facts = SessionProgress.facts(input)
  expect(facts).toContain('"requestElapsedMs":50')
  expect(facts).toContain('"activeMs":50')
  expect(facts).toContain('"unreported":1')
  expect(facts).not.toContain("remaining")
  expect(facts).not.toContain("Preserve the current runnable artifact")
  const limited = SessionProgress.facts({ ...input, budget: 1000, deadline: 200 })
  expect(limited).toContain('"remainingTokenUpperBound":200')
  expect(limited).toContain('"remainingMs":50')
  expect(limited).toContain("Preserve the current runnable artifact")
  expect(limited).not.toMatch(/[\u3400-\u9fff]/)
})

test("Q3 closing reopens on changed evidence, not on repeat final answers", () => {
  expect(SessionProgress.reviewDecision({ key: "green", previous: [], missing: [] })).toBe("review")
  expect(SessionProgress.reviewDecision({ key: "green", previous: ["green"], missing: [] })).toBe("finish")
  expect(
    SessionProgress.reviewDecision({ key: "green", previous: ["green"], missing: ["requirement 2 missing"] }),
  ).toBe("unverified")
  expect(SessionProgress.reviewDecision({ key: "changed", previous: ["green"], missing: ["stale check"] })).toBe(
    "review",
  )
  expect(
    SessionProgress.reviewDecision({ key: "failed", previous: ["green", "changed"], missing: ["new failure"] }),
  ).toBe("review")
})

test("Q4 same cause with changed parameters is observable, unknowns never prove stagnation", () => {
  const failure = {
    category: "exit",
    error: "authentication failed",
    cwd: "/project",
    environment: "shell-v1",
    artifact: "digest",
    hypothesis: "token rejected",
    expectedEvidence: "authentication status",
    evidence: "401",
  }
  expect(SessionProgress.stagnation(failure, failure).candidate).toBe(true)
  expect(SessionProgress.stagnation(failure, { ...failure, evidence: "403" }).candidate).toBe(false)
  expect(SessionProgress.stagnation(failure, { ...failure, hypothesis: "scope rejected" }).candidate).toBe(false)
  expect(SessionProgress.stagnation(undefined, failure).candidate).toBe(false)
  expect(SessionProgress.stagnation(failure, { ...failure, environment: undefined }).candidate).toBe(false)
})

test("Q4 repeated evidence without a hypothesis is a candidate with an explicit unknown", () => {
  const failure = {
    category: "exit",
    error: "authentication failed",
    cwd: "/project",
    environment: "shell-v1",
    artifact: "digest",
    evidence: "401",
  }
  expect(SessionProgress.stagnation(failure, failure)).toMatchObject({
    candidate: true,
    hypothesisUnknown: true,
    intervention: false,
  })
  expect(SessionProgress.stagnation(undefined, failure).candidate).toBe(false)
  expect(SessionProgress.stagnation(failure, { ...failure, artifact: "changed" }).candidate).toBe(false)
  expect(SessionProgress.stagnation(failure, { ...failure, evidence: "403" }).candidate).toBe(false)
  expect(SessionProgress.stagnation(failure, { ...failure, hypothesis: "new cause" }).candidate).toBe(false)
})

test("Q5 independent review names original sources, end-to-end evidence and unknowns", () => {
  expect(SessionProgress.independentReview).toContain("original source")
  expect(SessionProgress.independentReview).toContain("end-to-end")
  expect(SessionProgress.independentReview).toContain("unverified")
  expect(SessionProgress.independentReview).toContain("not independent proof")
})

test("quality configuration preserves omissions for runtime defaults", () => {
  expect(new ConfigExperimental.Experimental({}).quality_progress).toBeUndefined()
  const config = new ConfigExperimental.Experimental({ quality_progress: {} }).quality_progress
  expect(config?.facts).not.toBe(true)
  expect(config?.silent_command_ms).toBeUndefined()
  expect(config?.evidence_closing).not.toBe(true)
  expect(config?.stagnation_log).not.toBe(true)
  expect(config?.independent_review).not.toBe(true)
})
