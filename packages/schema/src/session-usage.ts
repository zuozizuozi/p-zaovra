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

export const Unpriced = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cacheRead: Schema.Finite,
  cacheWrite: Schema.Finite,
})

export const Bucket = Schema.Struct({
  providerID: Schema.NullOr(Schema.String),
  modelID: Schema.NullOr(Schema.String),
  tokens: Totals,
  priceConfigured: Schema.Boolean,
  pricedAmount: Schema.Finite,
  unpriced: Unpriced,
  modelUnavailable: Schema.Boolean,
  // USD, calculated per request with current location-specific catalog prices.
  estimate: Schema.NullOr(Schema.Finite),
})
export interface Bucket extends Schema.Schema.Type<typeof Bucket> {}

export const Summary = Schema.Struct({
  models: Schema.Array(Bucket),
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
