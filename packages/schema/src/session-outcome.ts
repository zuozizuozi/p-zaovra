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
export const ExecutionContext = Schema.Struct({
  entry: ExecutionCondition,
  cwd: ExecutionCondition,
  runtime: ExecutionCondition,
  timeout: ExecutionCondition,
  environment: ExecutionEnvironment,
}).annotate({ identifier: "SessionOutcome.ExecutionContext" })
export interface ExecutionContext extends Schema.Schema.Type<typeof ExecutionContext> {}

export const Check = Schema.Struct({
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
export const Info = Schema.Struct({
  state: Schema.Literals([
    "idle",
    "running",
    "completed",
    "completed_verified",
    "completed_unverified",
    "failed",
    "interrupted",
  ]),
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
