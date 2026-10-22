export * as SessionProgress from "./progress"

import { DateTime, Effect, Schema } from "effect"
import { createHash } from "node:crypto"
import path from "node:path"
import type { SessionOutcome } from "@zaovra-ai/schema/session-outcome"
import { and, desc, eq, sql } from "drizzle-orm"
import type { Database } from "../database/database"
import { SessionTable } from "./sql"
import { SessionSchema } from "./schema"
import { EventV2 } from "../event"
import { EventTable } from "../event/sql"
import { SessionEvent } from "./event"

export const State = Schema.Struct({
  activeMs: Schema.Number,
  request: Schema.String,
  requestStarted: Schema.Number,
  draining: Schema.optional(Schema.Boolean),
  activeTimeUnknown: Schema.optional(Schema.Boolean),
})

export function advance(
  previous: typeof State.Type | undefined,
  input: { now: number; active: number; request: string },
) {
  return {
    ...(previous?.draining === undefined ? {} : { draining: previous.draining }),
    ...(previous?.activeTimeUnknown ? { activeTimeUnknown: true } : {}),
    activeMs: (previous?.activeMs ?? 0) + Math.max(0, input.active),
    request: input.request,
    requestStarted: previous?.request === input.request ? previous.requestStarted : input.now,
  }
}

export const read = Effect.fn("SessionProgress.read")(function* (db: Database.Interface["db"], id: SessionSchema.ID) {
  const row = yield* db
    .select({ metadata: SessionTable.metadata })
    .from(SessionTable)
    .where(eq(SessionTable.id, id))
    .get()
    .pipe(Effect.orDie)
  return Schema.decodeUnknownOption(State)(row?.metadata?.qualityProgress)
})

export const save = Effect.fn("SessionProgress.save")(function* (
  db: Database.Interface["db"],
  id: SessionSchema.ID,
  state: typeof State.Type,
) {
  yield* db
    .update(SessionTable)
    .set({
      metadata: sql`json_set(coalesce(${SessionTable.metadata}, '{}'), '$.qualityProgress', json(${JSON.stringify(state)}))`,
    })
    .where(eq(SessionTable.id, id))
    .run()
    .pipe(Effect.orDie)
})

export function facts(input: {
  now: number
  state: typeof State.Type
  turns: number
  step: number
  limit?: number
  tokens: number
  unreported: number
  budget?: number
  deadline?: number
}) {
  const reminder =
    (input.budget !== undefined && input.tokens >= input.budget * 0.75) ||
    (input.deadline !== undefined && input.deadline - input.now <= 60_000)
  return `Current task facts (host observations, not new requirements): ${JSON.stringify({
    requestElapsedMs: Math.max(0, input.now - input.state.requestStarted),
    activeMs: input.state.activeMs,
    ...(input.state.activeTimeUnknown ? { activeTimeUnknown: true } : {}),
    providerTurns: input.turns,
    allowanceTurn: input.step,
    allowanceLimit: input.limit,
    knownTokens: input.tokens,
    unreported: input.unreported,
    ...(input.budget === undefined
      ? {}
      : input.unreported
        ? { remainingTokenUpperBound: Math.max(0, input.budget - input.tokens) }
        : { remainingTokens: Math.max(0, input.budget - input.tokens) }),
    ...(input.deadline === undefined ? {} : { remainingMs: Math.max(0, input.deadline - input.now) }),
  })}${reminder ? "\nPreserve the current runnable artifact and address the smallest acceptance gap first. Do not omit requirements or necessary validation." : ""}`
}

export function closingKey(input: {
  requirements: readonly unknown[]
  required: readonly string[]
  environment: unknown
  targets: readonly { path: string; digest: string }[]
  snapshot?: string
  checks: readonly SessionOutcome.Check[]
  review?: SessionOutcome.Review
  missing: readonly string[]
}) {
  const hash = (value: unknown) =>
    createHash("sha256")
      .update(
        JSON.stringify(value, (_key, value: unknown) =>
          value && typeof value === "object" && !Array.isArray(value)
            ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
            : value,
        ),
      )
      .digest("hex")
  const checks = input.checks.map((check) => ({
    id: check.callID,
    key: hash({
      kind: check.kind,
      command: check.command,
      cwd: check.cwd,
      exit: check.exit,
      execution: check.execution,
      resultDigest: check.exit !== 0 || check.sample ? check.resultDigest : undefined,
      sample: check.sample,
      targets: check.targets?.toSorted((a, b) => a.path.localeCompare(b.path)),
      assertions: check.assertions?.toSorted((a, b) => a.path.localeCompare(b.path)),
      executionContext: check.executionContext,
      contractDigest: check.contractDigest,
      superseded: Boolean(check.supersededBy),
    }),
  }))
  return hash({
    requirements: input.requirements,
    required: [...input.required].sort(),
    environment: input.environment,
    targets: input.targets.toSorted((a, b) => a.path.localeCompare(b.path)),
    snapshot: input.checks.some((check) => !check.targets?.length) ? input.snapshot : undefined,
    checks: [...new Set(checks.map((check) => check.key))].sort(),
    conclusions: input.review?.items
      .map((item) => ({
        requirement: item.requirement,
        status: item.status,
        kind: item.kind ?? "result",
        acceptance: item.acceptance ?? "real",
        coverage: item.coverage?.map((scope) => ({
          ...scope,
          callID: checks.find((check) => check.id === scope.callID)?.key ?? "unresolved",
        })),
        conditions: item.conditions,
        evidence: [
          ...new Set(item.evidence.map((id) => checks.find((check) => check.id === id)?.key ?? "unresolved")),
        ].sort(),
        history: item.history?.map((item) => ({ exit: item.exit, ordered: Boolean(item.before) })),
      }))
      .sort((a, b) => a.requirement - b.requirement),
    // Asking for the first review is not new evidence; absence of conclusions
    // already represents it. Otherwise the reminder itself reopens closing.
    gaps: [
      ...new Set(
        input.missing
          .filter((gap) => !gap.startsWith("requirements review:"))
          .map((gap) =>
            checks
              .reduce((text, check) => replaceReference(text, check.id, check.key), gap)
              .replace(/\s+/g, " ")
              .trim(),
          ),
      ),
    ].sort(),
  })
}

export function reviewDecision(input: {
  key: string
  previous: readonly string[]
  missing: readonly string[]
  verified?: boolean
  delivered?: boolean
  pending?: boolean
  gaps?: readonly string[]
  reviewed?: readonly string[]
}) {
  if (input.pending) return "pending"
  if (input.verified && input.delivered && !input.missing.length) return "sealed"
  if (input.gaps?.length && input.gaps.every((gap) => input.reviewed?.includes(gap))) return "unverified"
  if (!input.previous.includes(input.key)) return "review"
  return input.missing.length ? "unverified" : "finish"
}

// A reminder belongs to a requirement and a concrete defect, not the whole
// workspace. Unrelated new passing checks must not buy another reminder.
export function closingGaps(request: readonly unknown[], outcome: SessionOutcome.Info) {
  return (outcome.missing.length ? outcome.missing : ["requirements review: submit verification_review"]).map((gap) =>
    createHash("sha256")
      .update(
        JSON.stringify([
          request,
          outcome.checks
            .reduce(
              (text, check) =>
                replaceReference(
                  text,
                  check.callID,
                  JSON.stringify([
                    check.kind,
                    check.command,
                    check.cwd,
                    check.exit,
                    check.execution,
                    check.exit !== 0 || check.sample ? check.resultDigest : undefined,
                    check.sample,
                  ]),
                ),
              gap,
            )
            .replace(/requirements review:.*/, "requirements review")
            .replace(/\s+/g, " "),
        ]),
      )
      .digest("hex"),
  )
}

export const FailureObservation = Schema.Struct({
  category: Schema.String,
  error: Schema.String,
  cwd: Schema.String,
  environment: Schema.optional(Schema.String),
  artifact: Schema.optional(Schema.String),
  hypothesis: Schema.optional(Schema.String),
  expectedEvidence: Schema.optional(Schema.String),
  evidence: Schema.optional(Schema.String),
})

export type Failure = {
  category: string
  error: string
  cwd: string
  environment?: string
  artifact?: string
  hypothesis?: string
  expectedEvidence?: string
  evidence?: string
}

export function stagnation(previous: Failure | undefined, current: Failure) {
  const signature = JSON.stringify([current.category, current.error, current.cwd, current.environment ?? null])
  const comparable =
    current.environment !== undefined && current.artifact !== undefined && current.evidence !== undefined
  return {
    signature,
    hypothesisUnknown:
      current.hypothesis === undefined || (previous !== undefined && previous.hypothesis === undefined),
    candidate:
      comparable &&
      previous !== undefined &&
      JSON.stringify([previous.category, previous.error, previous.cwd, previous.environment ?? null]) === signature &&
      previous.artifact === current.artifact &&
      previous.hypothesis === current.hypothesis &&
      previous.evidence === current.evidence,
    expectedEvidence: current.expectedEvidence ?? "unknown",
    intervention: false,
  }
}

// Only recognized file reads are comparable. Job polling, test output and
// arbitrary successful commands may be making progress without changing files.
export function readEvidence(
  tool: string,
  input: Record<string, unknown>,
  structured: Record<string, unknown>,
  text: string,
  cwd = ".",
) {
  const command =
    typeof input.command === "string"
      ? /^(?:cat|type|Get-Content)\s+(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s;&|<>`$]+))\s*$/i.exec(input.command)
      : null
  const lines = text.replace(/\r\n/g, "\n").split("\n")
  const paths =
    tool === "grep"
      ? lines.filter((line) => line.endsWith(":") && !line.startsWith("  ")).map((line) => line.slice(0, -1))
      : []
  const file =
    tool === "read" && typeof input.path === "string"
      ? input.path
      : tool === "grep" && paths.length === 1
        ? paths[0]
        : tool === "bash" && command
          ? (command[1] ?? command[2] ?? command[3])
          : undefined
  const content =
    tool === "read" && typeof structured.content === "string"
      ? structured.content
      : tool === "grep"
        ? lines
            .filter((line) => /^  Line \d+: /.test(line))
            .map((line) => line.replace(/^  Line \d+: /, ""))
            .join("\n")
        : tool === "bash" && command
          ? text
          : undefined
  if (!file || !content?.trim()) return undefined
  return createHash("sha256")
    .update(JSON.stringify([path.resolve(cwd, file), content.replace(/\r\n/g, "\n").trimEnd()]))
    .digest("hex")
}

// History is newest first. A successful unrelated command cannot erase a
// recurring failure; successful reads need three consecutive equal facts.
export function observe(history: readonly Failure[], current: Failure) {
  const relevant = history.filter(
    (item) => item.category === current.category && item.error === current.error && item.cwd === current.cwd,
  )
  const result = stagnation(relevant[0], current)
  return {
    ...result,
    candidate: result.candidate && (current.category !== "read-only" || stagnation(relevant[1], current).candidate),
  }
}

// The 224 replay has no known hypotheses and cannot fit a precision threshold.
// Keep the existing three-observation read floor; this opt-in diagnostic is
// deliberately stricter and cannot treat unknowns or polling as evidence.
export function diagnostic(history: readonly Failure[], current: Failure) {
  if (!current.hypothesis?.trim() || history.length < 2) return
  if (
    !history.slice(0, 2).every((prior) => {
      const result = stagnation(prior, current)
      return result.candidate && !result.hypothesisUnknown
    })
  )
    return
  return createHash("sha256")
    .update(
      JSON.stringify([
        current.category,
        current.error,
        current.cwd,
        current.environment,
        current.artifact,
        current.hypothesis,
        current.evidence,
      ]),
    )
    .digest("hex")
}

export const diagnosticReminder = "下一步要区分哪两个仍成立的解释？看到什么会改变决策？"

export const independentReview =
  "Identify the original source for each critical assumption. Check the actual end-to-end result against that source. State unverified scope and why; self-written tests or another model's agreement are not independent proof."

export const record = Effect.fn("SessionProgress.record")(function* (
  events: EventV2.Interface,
  sessionID: SessionSchema.ID,
  category: "continuation" | "closing" | "stagnation" | "cache",
  details: Schema.Json,
) {
  yield* events.publish(SessionEvent.QualityProgress, { sessionID, timestamp: yield* DateTime.now, category, details })
})

export const recentObservations = Effect.fn("SessionProgress.recentObservations")(function* (
  db: Database.Interface["db"],
  id: SessionSchema.ID,
) {
  const rows = yield* db
    .select({ data: EventTable.data })
    .from(EventTable)
    .where(
      and(
        eq(EventTable.aggregate_id, id),
        eq(EventTable.type, "session.next.quality.progress.1"),
        sql`json_extract(${EventTable.data}, '$.category') = 'stagnation'`,
      ),
    )
    .orderBy(desc(EventTable.seq))
    .limit(50)
    .all()
    .pipe(Effect.orDie)
  return rows.flatMap((row) => {
    const prior = row.data.category === "stagnation" ? row.data.details : undefined
    if (!prior || typeof prior !== "object" || !("observation" in prior)) return []
    const decoded = Schema.decodeUnknownOption(FailureObservation)(prior.observation)
    return decoded._tag === "Some" ? [decoded.value] : []
  })
})

// References are tokens; short IDs must not replace letters inside evidence.
function replaceReference(text: string, id: string, value: string) {
  return text.replace(new RegExp(`(?<![\\w-])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "g"), () => value)
}
