import { expect, test } from "bun:test"
import { ConfigExperimental } from "../src/config/experimental"
import { SessionProgress } from "../src/session/progress"

test("K2 completion gaps deduplicate independently and waiting never seals", () => {
  const input = {
    key: "new unrelated evidence",
    previous: [],
    missing: ["test missing"],
    gaps: ["test"],
    reviewed: ["test"],
  }
  expect(SessionProgress.reviewDecision(input)).toBe("unverified")
  expect(SessionProgress.reviewDecision({ ...input, gaps: ["test", "new counterexample"] })).toBe("review")
  expect(
    SessionProgress.reviewDecision({ ...input, missing: [], verified: true, delivered: true, pending: true }),
  ).toBe("pending")
})

test("K2 diagnostic requires three consecutive known same-family observations and is once per evidence", () => {
  const current = {
    category: "exit-1",
    error: "missing entry",
    cwd: "/app",
    environment: "shell",
    artifact: "v1",
    evidence: "same",
    hypothesis: "entry mismatch",
  }
  expect(SessionProgress.diagnostic([current], current)).toBeUndefined()
  const key = SessionProgress.diagnostic([current, current], current)
  expect(key).toBeDefined()
  expect(SessionProgress.diagnostic([current, current], { ...current, hypothesis: undefined })).toBeUndefined()
  expect(SessionProgress.diagnostic([current, current], { ...current, hypothesis: " " })).toBeUndefined()
  expect(SessionProgress.diagnostic([current, current], { ...current, artifact: undefined })).toBeUndefined()
  expect(SessionProgress.diagnostic([{ ...current, evidence: "new" }, current], current)).toBeUndefined()
  expect(SessionProgress.diagnostic([current, current], { ...current, hypothesis: "other cause" })).toBeUndefined()
  expect(SessionProgress.diagnostic([current, current], current)).toBe(key)
})

test("K2 gap identity ignores unrelated checks and call IDs, but distinguishes a concrete failure", () => {
  const check = { kind: "test" as const, command: "test relevant", exit: 1, callID: "c1" }
  const outcome = {
    state: "completed_unverified" as const,
    outcomeUnknown: false,
    checks: [check],
    missing: ["failed: test (c1)"],
  }
  const key = SessionProgress.closingGaps(["original requirement"], outcome)
  expect(
    SessionProgress.closingGaps(["original requirement"], {
      ...outcome,
      checks: [
        { ...check, callID: "c2" },
        { ...check, command: "unrelated pass", exit: 0, callID: "other" },
      ],
      missing: ["failed: test (c2)"],
    }),
  ).toEqual(key)
  expect(
    SessionProgress.closingGaps(["original requirement"], {
      ...outcome,
      checks: [{ ...check, command: "new counterexample" }],
    }),
  ).not.toEqual(key)
})

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

test("K1 closing key ignores call IDs and review prose but retains counterexamples and contract changes", () => {
  const check = {
    kind: "test" as const,
    command: "node verify.js",
    exit: 0,
    callID: "first",
    targets: [{ path: "app.js", digest: "v1" }],
  }
  const input = {
    requirements: [{ id: "r1", text: "Deliver app" }],
    required: ["test"],
    environment: "runtime1",
    targets: check.targets,
    checks: [check],
    missing: [],
    review: {
      userMessageID: "u1",
      items: [{ requirement: 1, status: "verified" as const, evidence: ["first"], note: "passed" }],
      unverified: [],
    },
  }
  const key = SessionProgress.closingKey(input)
  expect(
    SessionProgress.closingKey({
      ...input,
      checks: [{ ...check, callID: "second" }],
      review: {
        ...input.review,
        items: [{ ...input.review.items[0], evidence: ["second"], note: "looks good with different words" }],
      },
    }),
  ).toBe(key)
  expect(SessionProgress.closingKey({ ...input, checks: [{ ...check, exit: 1 }] })).not.toBe(key)
  expect(SessionProgress.closingKey({ ...input, targets: [{ path: "app.js", digest: "v2" }] })).not.toBe(key)
  expect(SessionProgress.closingKey({ ...input, environment: "runtime2" })).not.toBe(key)
  expect(SessionProgress.closingKey({ ...input, requirements: [{ id: "r2", text: "Changed task" }] })).not.toBe(key)
  expect(SessionProgress.reviewDecision({ key, previous: [], missing: [], verified: true, delivered: true })).toBe(
    "sealed",
  )
  expect(SessionProgress.reviewDecision({ key, previous: [], missing: [], verified: false, delivered: true })).toBe(
    "review",
  )
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

test("K1 shadow observes cross-tool repetition and preserves failures across unrelated success", () => {
  const read = SessionProgress.readEvidence("read", { path: "a.ts" }, { content: "const answer = 42;\n" }, "")
  const grep = SessionProgress.readEvidence(
    "grep",
    { path: "a.ts" },
    {},
    "Found 1 matches\na.ts:\n  Line 1: const answer = 42;",
  )
  const cat = SessionProgress.readEvidence("bash", { command: "cat a.ts" }, { exit: 0 }, "const answer = 42;\n")
  expect(read).toBeDefined()
  expect(grep).toBe(read)
  expect(cat).toBe(read)
  const observation = {
    category: "read-only",
    error: "",
    cwd: "/project",
    environment: "shell",
    artifact: "v1",
    evidence: read,
  }
  expect(SessionProgress.observe([observation, observation], observation)).toMatchObject({
    candidate: true,
    intervention: false,
  })
  expect(SessionProgress.observe([observation], observation).candidate).toBe(false)
  expect(
    SessionProgress.observe([observation, observation], { ...observation, evidence: "new information" }).candidate,
  ).toBe(false)
  expect(SessionProgress.observe([observation, observation], { ...observation, artifact: "v2" }).candidate).toBe(false)
  const failure = { ...observation, category: "exit-1", error: "same failure" }
  expect(SessionProgress.observe([observation, failure], failure)).toMatchObject({
    candidate: true,
    intervention: false,
  })
  expect(SessionProgress.readEvidence("bash_job", { operation: "wait" }, { exit: 0 }, "growing output")).toBeUndefined()
  expect(SessionProgress.readEvidence("bash", { command: "bun test" }, { exit: 0 }, "growing output")).toBeUndefined()
  expect(SessionProgress.readEvidence("bash", { command: "cat a.ts; run.exe" }, { exit: 0 }, "same")).toBeUndefined()
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
