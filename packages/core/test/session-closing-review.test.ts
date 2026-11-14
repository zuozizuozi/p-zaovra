import { expect, test } from "bun:test"
import { DateTime } from "effect"
import { ClosingReview } from "../src/session/closing-review"
import { SessionOutcome } from "../src/session/outcome"
import { SessionMessage } from "../src/session/message"
import { SessionProgress } from "../src/session/progress"

const messages: SessionMessage.Message[] = [
  {
    id: SessionMessage.ID.make("msg_original"),
    type: "user",
    text: "Verify the parser",
    time: { created: DateTime.makeUnsafe(1) },
  },
]
const request = SessionOutcome.requested(messages).entries
const outcome = {
  ...SessionOutcome.derive(messages, false),
  outcomeUnknown: false,
  missing: ["first gap", "second gap"],
}

test("legacy eligibility respects the request-scoped prefix and engineering gate", () => {
  expect(ClosingReview.legacyDue(false, [])).toBe(false)
  expect(ClosingReview.legacyDue(0, [])).toBe(0)
  expect(ClosingReview.legacyDue(1, [])).toBe(true)
  expect(ClosingReview.legacyDue(true, [{ data: { text: "Verification closing review: old" } }])).toBe(false)
  expect(ClosingReview.legacyDue(true, [{ data: { text: "quoted Verification closing review: old" } }])).toBe(true)
  expect(ClosingReview.legacyDue(true, [{ data: {} }, { data: { text: 42 } }])).toBe(true)
})

for (const details of [null, "review", {}, { key: 7, decision: "review" }, { key: "current", decision: "pending" }])
  test(`malformed or non-review history does not consume evidence review: ${JSON.stringify(details)}`, () => {
    expect(
      ClosingReview.evidenceDecision(
        request,
        outcome,
        "current",
        false,
        [],
        [
          { data: { category: "closing", details } },
          { data: { category: "stagnation", details: { key: "current", decision: "review" } } },
        ],
      ).decision,
    ).toBe("review")
  })

test("same key blocks repeat review, new key reopens only a new gap", () => {
  const first = ClosingReview.evidenceDecision(request, outcome, "first", false, [], [])
  const previous = [
    { data: { category: "closing", details: { key: "first", decision: "review", gaps: [...first.gaps, 7, null] } } },
  ]
  expect(ClosingReview.evidenceDecision(request, outcome, "first", false, [], previous).decision).toBe("unverified")
  expect(ClosingReview.evidenceDecision(request, outcome, "new", false, [], previous).decision).toBe("unverified")
  const changed = { ...outcome, missing: [...outcome.missing, "new failure"] }
  const review = ClosingReview.evidenceDecision(request, changed, "new", false, [], previous)
  expect(review.decision).toBe("review")
  expect(review.reviewed).toEqual(first.gaps)
  const prompt = ClosingReview.evidencePrompt("new", changed, review.gaps, review.reviewed, false)
  expect(prompt).toContain('Missing: ["new failure"]')
  expect(prompt).not.toContain("first gap")
  expect(previous[0].data.details.gaps).toEqual([...first.gaps, 7, null])
})

for (const unknown of [false, true])
  test(`pending jobs and unknown outcome cannot consume a review: unknown=${unknown}`, () => {
    expect(
      ClosingReview.evidenceDecision(
        request,
        { ...outcome, outcomeUnknown: unknown },
        "current",
        true,
        unknown ? [] : ["running-job"],
        [],
      ).decision,
    ).toBe("pending")
  })

test("a repeated key with no missing evidence finishes without manufacturing verification", () => {
  const previous = [{ data: { category: "closing", details: { key: "same", decision: "review" } } }]
  expect(
    ClosingReview.evidenceDecision(request, { ...outcome, missing: [] }, "same", true, [], previous).decision,
  ).toBe("finish")
})

for (const independent of [false, true])
  test(`legacy prompt preserves failed evidence, coverage order and independent opt-in: ${independent}`, () => {
    const state: ReturnType<typeof SessionOutcome.derive> = {
      ...outcome,
      checks: [
        { kind: "test", command: "old failure", callID: "old", exit: 1, supersededBy: "new" },
        { kind: "test", command: "timeout", callID: "bad", exit: 1, execution: "timeout" },
        { kind: "test", command: "pass", callID: "new", exit: 0, requirements: ["second", "first"] },
      ],
    }
    const prompt = ClosingReview.legacyPrompt(messages, state, independent)
    const payload = JSON.parse(prompt.slice("Verification closing review: ".length).split("\n")[0])
    expect(Object.keys(payload)).toEqual([
      "state",
      "facts",
      "missing",
      "failed",
      "coverage",
      "userRequests",
      "requirements",
    ])
    expect(payload.failed).toEqual([{ kind: "test", command: "timeout", execution: "timeout" }])
    expect(payload.coverage).toEqual(["second", "first"])
    expect(payload.userRequests).toEqual(["Verify the parser"])
    expect(payload.requirements).toEqual(request)
    expect(prompt.includes(SessionProgress.independentReview)).toBe(independent)
    expect(
      ClosingReview.evidencePrompt("key", outcome, [], [], independent).includes(SessionProgress.independentReview),
    ).toBe(independent)
  })
