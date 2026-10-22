export * as SessionOutcome from "./session-outcome"

import { Schema } from "effect"
import { optional } from "./schema"

export const ExecutionValue = Schema.Struct({
  value: Schema.NullOr(Schema.String),
  source: Schema.Literals(["user", "observed", "default", "diagnostic-temporary", "unknown"]),
}).annotate({ identifier: "SessionOutcome.ExecutionValue" })
export interface ExecutionValue extends Schema.Schema.Type<typeof ExecutionValue> {}
export const ExecutionCondition = Schema.Struct({
  requested: ExecutionValue.pipe(optional),
  observed: ExecutionValue,
}).annotate({ identifier: "SessionOutcome.ExecutionCondition" })
export interface ExecutionCondition extends Schema.Schema.Type<typeof ExecutionCondition> {}
export const ExecutionEnvironment = Schema.Struct({
  OMP_NUM_THREADS: ExecutionCondition.pipe(optional),
  MKL_NUM_THREADS: ExecutionCondition.pipe(optional),
  OPENBLAS_NUM_THREADS: ExecutionCondition.pipe(optional),
  NUMEXPR_NUM_THREADS: ExecutionCondition.pipe(optional),
  VECLIB_MAXIMUM_THREADS: ExecutionCondition.pipe(optional),
  BLIS_NUM_THREADS: ExecutionCondition.pipe(optional),
}).annotate({ identifier: "SessionOutcome.ExecutionEnvironment" })
export interface ExecutionEnvironment extends Schema.Schema.Type<typeof ExecutionEnvironment> {}
export const ExecutionContract = Schema.Struct({
  version: Schema.Literal(1),
  entry: Schema.String.pipe(optional),
  cwd: Schema.String.pipe(optional),
  runtime: Schema.String.pipe(optional),
  timeout: Schema.String.pipe(optional),
  samples: Schema.Array(Schema.String).pipe(optional),
  environment: Schema.Struct({
    OMP_NUM_THREADS: Schema.String.pipe(optional),
    MKL_NUM_THREADS: Schema.String.pipe(optional),
    OPENBLAS_NUM_THREADS: Schema.String.pipe(optional),
    NUMEXPR_NUM_THREADS: Schema.String.pipe(optional),
    VECLIB_MAXIMUM_THREADS: Schema.String.pipe(optional),
    BLIS_NUM_THREADS: Schema.String.pipe(optional),
  }).pipe(optional),
}).annotate({ identifier: "SessionOutcome.ExecutionContract" })
export interface ExecutionContract extends Schema.Schema.Type<typeof ExecutionContract> {}
export const ExecutionContext = Schema.Struct({
  contract: Schema.Struct({ version: Schema.Literal(1), sourceMessageID: Schema.String, digest: Schema.String }).pipe(
    optional,
  ),
  entry: ExecutionCondition,
  cwd: ExecutionCondition,
  runtime: ExecutionCondition,
  timeout: ExecutionCondition,
  environment: ExecutionEnvironment,
}).annotate({ identifier: "SessionOutcome.ExecutionContext" })
export interface ExecutionContext extends Schema.Schema.Type<typeof ExecutionContext> {}

export const ExecutionRecord = Schema.Struct({
  scope: Schema.Struct({
    cwd: Schema.String,
    command: Schema.String,
    targets: Schema.Array(Schema.String),
    kind: Schema.String.pipe(optional),
    sample: Schema.String.pipe(optional),
  }),
  id: Schema.String,
  originCallID: Schema.String,
  jobID: Schema.String.pipe(optional),
  sequence: Schema.Number,
  started: Schema.Number,
  completed: Schema.Number.pipe(optional),
  exit: Schema.Number.pipe(optional),
}).annotate({ identifier: "SessionOutcome.ExecutionRecord" })
export interface ExecutionRecord extends Schema.Schema.Type<typeof ExecutionRecord> {}

export const Check = Schema.Struct({
  executionRecord: ExecutionRecord.pipe(optional),
  resultDigest: Schema.String.pipe(optional),
  sample: Schema.Struct({ id: Schema.String, planDigest: Schema.String }).pipe(optional),
  kind: Schema.Literals(["build", "test", "lint", "typecheck", "syntax", "smoke", "interaction"]),
  command: Schema.String,
  exit: Schema.Number,
  execution: Schema.Literals(["not-run", "invalid-report", "timeout"]).pipe(optional),
  requirements: Schema.Array(Schema.String).pipe(optional),
  assertions: Schema.Array(Schema.Struct({ path: Schema.String, digest: Schema.String })).pipe(optional),
  supersededBy: Schema.String.pipe(optional),
  snapshot: Schema.String.pipe(optional),
  callID: Schema.String,
  cwd: Schema.String.pipe(optional),
  targets: Schema.Array(Schema.Struct({ path: Schema.String, digest: Schema.String })).pipe(optional),
  logs: Schema.Array(Schema.String).pipe(optional),
  executionContext: ExecutionContext.pipe(optional),
  contractDigest: Schema.String.pipe(optional),
}).annotate({ identifier: "SessionOutcome.Check" })
export interface Check extends Schema.Schema.Type<typeof Check> {}
export const Review = Schema.Struct({
  userMessageID: Schema.String,
  items: Schema.Array(
    Schema.Struct({
      requirement: Schema.Int,
      evidence: Schema.Array(Schema.String),
      kind: Schema.Literals(["result", "process"]).pipe(optional),
      history: Schema.Array(
        Schema.Struct({ callID: Schema.String, exit: Schema.Number, before: Schema.String.pipe(optional) }),
      ).pipe(optional),
      status: Schema.Literals(["verified", "unverified"]),
      note: Schema.String,
    }),
  ),
  unverified: Schema.Array(Schema.String),
  notes: Schema.Array(Schema.Struct({ text: Schema.String, requirements: Schema.Array(Schema.Int) })).pipe(optional),
}).annotate({ identifier: "SessionOutcome.Review" })
export interface Review extends Schema.Schema.Type<typeof Review> {}
export const DefaultBudget = { tokens: 30_000_000, durationMs: 12 * 60 * 60 * 1000 } as const

export const Budget = Schema.Struct({
  // An explicitly supplied object replaces both limits; omitted fields remove limits.
  tokens: Schema.Int.check(Schema.isGreaterThan(0)).pipe(optional),
  durationMs: Schema.Int.check(Schema.isGreaterThan(0)).pipe(optional),
}).annotate({ identifier: "SessionOutcome.Budget" })
export interface Budget extends Schema.Schema.Type<typeof Budget> {}
export const BudgetStatus = Schema.Struct({
  limits: Budget,
  used: Schema.Struct({ tokens: Schema.Finite, durationMs: Schema.Finite }),
  unreported: Schema.Finite,
}).annotate({ identifier: "SessionOutcome.BudgetStatus" })
export interface BudgetStatus extends Schema.Schema.Type<typeof BudgetStatus> {}
export const Termination = Schema.Struct({
  category: Schema.Literals([
    "provider-turn-limit",
    "budget",
    "output-exhausted",
    "text-truncation",
    "auth",
    "quota",
    "rate_limit",
    "overload",
    "network",
    "request",
    "provider_output",
    "internal",
    "content_filter",
    "interrupted",
  ]),
  message: Schema.String,
  statusCode: Schema.Number.pipe(optional),
  provider: Schema.String.pipe(optional),
  source: Schema.Literals(["user", "permission", "process-exit", "placement-change"]).pipe(optional),
}).annotate({ identifier: "SessionOutcome.Termination" })
export interface Termination extends Schema.Schema.Type<typeof Termination> {}
export const Info = Schema.Struct({
  state: Schema.Literals([
    "idle",
    "running",
    "completed",
    "completed_verified",
    "completed_unverified",
    "failed",
    "interrupted",
    "stopped",
  ]),
  termination: Termination.pipe(optional),
  runtime: Schema.Literals(["idle", "running", "completed", "stopped", "interrupted", "failed"]).pipe(optional),
  verification: Schema.Literals(["verified", "unverified", "failed"]).pipe(optional),
  outcomeUnknown: Schema.Boolean,
  checks: Schema.Array(Check),
  recentChecks: Schema.Array(
    Schema.Struct({
      check: Check,
      userMessageID: Schema.String,
      turn: Schema.Int,
      fresh: Schema.Boolean,
    }),
  ).pipe(optional),
  missing: Schema.Array(Schema.String),
  review: Review.pipe(optional),
  messageID: Schema.String.pipe(optional),
}).annotate({ identifier: "SessionOutcome.Info" })
export interface Info extends Schema.Schema.Type<typeof Info> {}
