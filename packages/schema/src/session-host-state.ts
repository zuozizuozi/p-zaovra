export * as SessionHostState from "./session-host-state"

import { Schema } from "effect"
import { Model } from "./model"
import { optional } from "./schema"

export interface DeliveryReceipt extends Schema.Schema.Type<typeof DeliveryReceipt> {}
export const DeliveryReceipt = Schema.Struct({
  request: Schema.String,
  started: Schema.Number,
  tokens: Schema.Number,
  decision: Schema.Literals(["review", "repair", "consumed", "finished", "unverified"]),
  missing: Schema.Array(Schema.String),
  reason: optional(Schema.String),
  turns: optional(Schema.Number),
  toolCalls: optional(Schema.Number),
  report: optional(Schema.Boolean),
  // Freeze the original allowance. Repair consumption earns no new credit.
  allowance: optional(Schema.Number),
  spent: optional(Schema.Number),
  cacheRead: optional(Schema.Number),
  estimatedCost: optional(Schema.Number),
  model: optional(Schema.String),
  costs: optional(Schema.Array(Model.Cost)),
  limits: optional(
    Schema.Struct({
      turns: Schema.Number,
      totalTokens: Schema.Number,
      outputTokens: Schema.Number,
      durationMs: Schema.Number,
      toolChecks: Schema.Number,
    }),
  ),
})

export interface Facts extends Schema.Schema.Type<typeof Facts> {}
export const Facts = Schema.Struct({
  activeMs: optional(Schema.Finite),
  remainingTokens: optional(Schema.Finite),
  remainingTokenUpperBound: optional(Schema.Finite),
  advisoryOnly: optional(Schema.Boolean),
  sourceRequest: Schema.String,
  contextEpoch: Schema.Number,
  requestElapsedMs: Schema.Number,
  providerTurns: Schema.Number,
  allowanceTurn: Schema.Number,
  allowanceLimit: optional(Schema.Number),
  knownTokens: Schema.Number,
  unreported: Schema.Number,
  activeTimeUnknown: optional(Schema.Boolean),
  budgetLimit: optional(Schema.Number),
  hardDeadline: optional(Schema.Number),
  executionDeadline: optional(Schema.Number),
  advisoryDeadline: optional(Schema.Number),
  remainingMs: optional(Schema.Number),
  executableRemainingMs: optional(Schema.Number),
  advisoryRemainingMs: optional(Schema.Number),
})

export interface BudgetClosing extends Schema.Schema.Type<typeof BudgetClosing> {}
export const BudgetClosing = Schema.Struct({
  requestID: optional(Schema.String),
  sourceMessageID: optional(Schema.String),
  deadline: optional(Schema.Finite),
  closingReserveMs: optional(Schema.Finite),
  providerDeadline: optional(Schema.Finite),
  state: Schema.Literal("stopped_unverified"),
  cancelled: Schema.Array(Schema.String),
  preserved: Schema.Array(Schema.String),
})
export interface Observation extends Schema.Schema.Type<typeof Observation> {}
export const Observation = Schema.Struct({
  category: Schema.String,
  error: Schema.String,
  cwd: Schema.String,
  environment: optional(Schema.String),
  artifact: optional(Schema.String),
  hypothesis: optional(Schema.String),
  expectedEvidence: optional(Schema.String),
  evidence: optional(Schema.String),
})

export const State = Schema.Union([
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("verification-decision"),
    key: Schema.String,
    decision: Schema.Literals(["pending", "sealed", "unverified", "review", "finish"]),
    gaps: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("stagnation-observation"),
    observation: Observation,
  }),
  Schema.Struct({ version: Schema.Literal(1), kind: Schema.Literal("delivery"), receipt: DeliveryReceipt }),
  Schema.Struct({ version: Schema.Literal(1), kind: Schema.Literal("budget-closing"), receipt: BudgetClosing }),
  Schema.Struct({ version: Schema.Literal(1), kind: Schema.Literal("budget-checkpoint") }),
  Schema.Struct({ version: Schema.Literal(1), kind: Schema.Literal("budget-notice"), limit: Schema.Finite }),
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("verification"),
    request: optional(Schema.String),
    mode: Schema.Literals(["legacy", "evidence"]),
    key: optional(Schema.String),
    gaps: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("stagnation"),
    request: optional(Schema.String),
    key: Schema.String,
  }),
  Schema.Struct({ version: Schema.Literal(1), kind: Schema.Literal("facts"), snapshot: Facts }),
]).annotate({ identifier: "Session.HostState" })
export type State = typeof State.Type

// Keep unsupported/corrupt JSON visible through replay and clients. Execution
// validates State before using it; absence alone enables legacy text parsing.
export const Stored = Schema.Union([Schema.Json, State]).annotate({ identifier: "Session.StoredHostState" })
