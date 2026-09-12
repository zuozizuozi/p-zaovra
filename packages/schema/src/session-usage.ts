export * as SessionUsage from "./session-usage"

import { Schema } from "effect"

export const Totals = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  reasoning: Schema.Finite,
  cacheRead: Schema.Finite,
  cacheWrite: Schema.Finite,
  total: Schema.Finite,
  calls: Schema.Finite,
  unreported: Schema.Finite,
})
export type Totals = typeof Totals.Type

export const Summary = Schema.Struct({
  total: Totals,
  own: Totals,
  official: Totals,
  unknown: Totals,
  lastTurn: Schema.NullOr(Totals),
  updatedAt: Schema.Finite,
  // Tokens are local observations, never a substitute for an account billing API.
  billing: Schema.Literal("unavailable"),
})
export type Summary = typeof Summary.Type
