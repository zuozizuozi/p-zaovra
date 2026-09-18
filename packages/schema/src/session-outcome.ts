export * as SessionOutcome from "./session-outcome"

import { Schema } from "effect"
import { optional } from "./schema"

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
  state: Schema.Literals(["idle", "running", "completed_verified", "completed_unverified", "failed", "interrupted"]),
  outcomeUnknown: Schema.Boolean,
  checks: Schema.Array(Check),
  missing: Schema.Array(Schema.String),
  review: Review.pipe(optional),
  messageID: Schema.String.pipe(optional),
}).annotate({ identifier: "SessionOutcome.Info" })
export interface Info extends Schema.Schema.Type<typeof Info> {}
