export * as SessionOutcome from "./session-outcome"

import { Schema } from "effect"
import { optional } from "./schema"

export const Check = Schema.Struct({
  kind: Schema.Literals(["build", "test", "lint", "typecheck"]),
  command: Schema.String,
  exit: Schema.Number,
  snapshot: Schema.String.pipe(optional),
  callID: Schema.String,
}).annotate({ identifier: "SessionOutcome.Check" })
export interface Check extends Schema.Schema.Type<typeof Check> {}
export const Info = Schema.Struct({
  state: Schema.Literals(["idle", "running", "completed_verified", "completed_unverified", "failed", "interrupted"]),
  outcomeUnknown: Schema.Boolean,
  checks: Schema.Array(Check),
  missing: Schema.Array(Schema.String),
  messageID: Schema.String.pipe(optional),
}).annotate({ identifier: "SessionOutcome.Info" })
export interface Info extends Schema.Schema.Type<typeof Info> {}
