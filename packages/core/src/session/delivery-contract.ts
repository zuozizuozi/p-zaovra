export * as DeliveryContract from "./delivery-contract"

import { Schema, Option } from "effect"
import { Token } from "../util/token"
import type { SessionMessage } from "./message"

/** Separate from strict verification. A review cannot execute external actions. */
export const budget = { turns: 1, output: 1_024, tokens: 16_000, durationMs: 20_000, tools: 0, ratio: 0.15 } as const
export const prefix = "Delivery contract review: "
export const Receipt = Schema.Struct({
  request: Schema.String,
  started: Schema.Number,
  tokens: Schema.Number,
  decision: Schema.Literals(["review", "consumed", "unverified"]),
  missing: Schema.Array(Schema.String),
  reason: Schema.optional(Schema.String),
  limits: Schema.optional(
    Schema.Struct({
      turns: Schema.Number,
      totalTokens: Schema.Number,
      outputTokens: Schema.Number,
      durationMs: Schema.Number,
      toolChecks: Schema.Number,
    }),
  ),
})

export function receipt(messages: readonly SessionMessage.Message[], request: string | undefined) {
  return messages
    .flatMap((message) => {
      if (message.type !== "synthetic" || !message.text.startsWith(prefix)) return []
      const decoded = Schema.decodeUnknownOption(Schema.UnknownFromJsonString.pipe(Schema.decodeTo(Receipt)))(
        message.text.slice(prefix.length),
      )
      return Option.isSome(decoded) && decoded.value.request === request ? [{ ...decoded.value, id: message.id }] : []
    })
    .at(-1)
}

export function allowance(known: number, unreported: number, request: unknown) {
  const tokens = Math.min(budget.tokens, Math.floor(known * budget.ratio))
  // Include the whole request, not only the short added instruction. Unknown
  // historical usage never becomes an inferred allowance.
  const input = Token.estimate(JSON.stringify(request)) + 512
  return { tokens, output: unreported ? 0 : Math.max(0, Math.min(budget.output, tokens - input)) }
}
