export * as SessionUsage from "./session-usage"

import { Schema } from "effect"
import { optional } from "./schema"

export const CacheAttempt = Schema.Struct({
  id: Schema.String,
  phase: Schema.Literals(["start", "headers", "failed"]),
  status: Schema.Number.pipe(optional),
})

export const CachePoint = Schema.Struct({
  responseModel: Schema.NullOr(Schema.String).pipe(optional),
  systemFingerprint: Schema.NullOr(Schema.String).pipe(optional),
  purpose: Schema.Literals(["execution", "summary"]).pipe(optional),
  attempts: Schema.Array(CacheAttempt).pipe(optional),
  requestID: Schema.String,
  sequence: Schema.Number,
  reason: Schema.String,
  firstChanged: Schema.NullOr(Schema.String),
  input: Schema.NullOr(Schema.Finite),
  output: Schema.NullOr(Schema.Finite),
  hit: Schema.NullOr(Schema.Finite),
  miss: Schema.NullOr(Schema.Finite),
  hitRate: Schema.NullOr(Schema.Finite),
  reasoning: Schema.NullOr(Schema.Finite),
  visible: Schema.NullOr(Schema.Finite),
  total: Schema.NullOr(Schema.Finite),
}).annotate({ identifier: "SessionUsage.CachePoint" })
export interface CachePoint extends Schema.Schema.Type<typeof CachePoint> {}

export const CacheReport = Schema.Struct({
  versions: Schema.Array(
    Schema.Struct({
      responseModel: Schema.NullOr(Schema.String),
      systemFingerprint: Schema.NullOr(Schema.String),
      calls: Schema.Finite,
      input: Schema.Finite,
      output: Schema.Finite,
      total: Schema.Finite,
      unreported: Schema.Finite,
    }),
  ).pipe(optional),
  points: Schema.Array(CachePoint),
  breaks: Schema.Array(Schema.Struct({ reason: Schema.String, count: Schema.Number })),
}).annotate({ identifier: "SessionUsage.CacheReport" })
export interface CacheReport extends Schema.Schema.Type<typeof CacheReport> {}

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
  cache: CacheReport.pipe(optional),
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
