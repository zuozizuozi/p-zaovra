export * as ClosingReview from "./closing-review"

import { SessionOutcome } from "./outcome"
import { SessionProgress } from "./progress"
import type { SessionMessage } from "./message"

// Legacy review is scoped by the runner's query to the latest user request.
// Evidence review instead uses persisted keys and reviewed gaps across history.
export function legacyDue(candidate: number | boolean, reviews: readonly { data: object }[]) {
  return (
    candidate &&
    !reviews.some(
      (row) =>
        "text" in row.data &&
        typeof row.data.text === "string" &&
        row.data.text.startsWith("Verification closing review:"),
    )
  )
}

export function evidenceDecision(
  request: ReturnType<typeof SessionOutcome.requested>["entries"],
  outcome: ReturnType<typeof SessionOutcome.derive>,
  key: string,
  delivered: boolean,
  pending: readonly unknown[],
  previous: readonly { data: { category?: unknown; details?: unknown } }[],
) {
  const keys = previous.flatMap((row) =>
    row.data.category === "closing" &&
    row.data.details &&
    typeof row.data.details === "object" &&
    "key" in row.data.details &&
    "decision" in row.data.details &&
    row.data.details.decision === "review" &&
    typeof row.data.details.key === "string"
      ? [row.data.details.key]
      : [],
  )
  const gaps = SessionProgress.closingGaps(request, outcome)
  const reviewed = previous.flatMap((row) => {
    const details = row.data.details
    return row.data.category === "closing" &&
      details &&
      typeof details === "object" &&
      "decision" in details &&
      details.decision === "review" &&
      "gaps" in details &&
      Array.isArray(details.gaps)
      ? details.gaps.filter((gap): gap is string => typeof gap === "string")
      : []
  })
  const decision = SessionProgress.reviewDecision({
    key,
    previous: keys,
    missing: outcome.missing,
    verified: outcome.state === "completed_verified" && outcome.review !== undefined,
    delivered,
    pending: outcome.outcomeUnknown || pending.length > 0,
    gaps,
    reviewed,
  })
  return { decision, gaps, reviewed }
}

export function evidencePrompt(
  key: string,
  outcome: ReturnType<typeof SessionOutcome.derive>,
  gaps: readonly string[],
  reviewed: readonly string[],
  independent: boolean,
) {
  return `Verification closing review: evidence key ${key}. Missing: ${JSON.stringify(outcome.missing.filter((_gap, index) => !reviewed.includes(gaps[index])))}. Compare original requirements with current artifacts and actual assertions, including uncovered negative cases. Reopen only checks affected by changed requirements, dependencies, environment or new failures. All green is not proof of full coverage. Preserve failed assertions and report unresolved scope; do not repeat unchanged passing checks.${independent ? ` ${SessionProgress.independentReview}` : ""}`
}

export function legacyPrompt(
  messages: readonly SessionMessage.Message[],
  outcome: ReturnType<typeof SessionOutcome.derive>,
  independent: boolean,
) {
  return `Verification closing review: ${JSON.stringify({
    state: outcome.state,
    facts: SessionOutcome.deliveryFacts(messages),
    missing: outcome.missing,
    failed: outcome.checks
      .filter((check) => check.exit !== 0 && !check.supersededBy)
      .map((check) => ({ kind: check.kind, command: check.command, execution: check.execution })),
    coverage: outcome.checks.filter((check) => check.exit === 0).flatMap((check) => check.requirements ?? []),
    userRequests: messages.filter((message) => message.type === "user").map((message) => message.text),
    requirements: SessionOutcome.requested(messages).entries,
  })}\nReview the original visible user requirements and their corrections against the final artifacts, even when all existing tests passed. Identify requirements not covered by the tests, including empty/minimum values, negative/error cases and stated invariants. Inspect the actual assertions, add focused checks for uncovered requirements, and correct concrete defects in this same loop. Use ordinary bash commands with verification_requirements to describe requirements actually asserted; identify verification_assertions and include source and assertion files as verification_targets. Do not output report JSON as a shell command. Preserve failed assertions when repairing implementation. If an assertion is wrong, explain the user requirement supporting the correction and report the original failure as requiring review; changing expectations is not proof of a fix. A self-written green test suite is not independent proof of full acceptance. Preserve valid existing checks, do not run unrelated checks or invent extra deliverables. If evidence remains missing, explicitly report unverified scope and known failures. This automatic closing review occurs at most once for this user request.${independent ? ` ${SessionProgress.independentReview}` : ""}`
}
