export * as DeepSeekOptions from "./deepseek-options"

import { Effect, Schema } from "effect"
import type { LLMRequest } from "../../schema"
import { ProviderShared } from "../shared"

export const Effort = Schema.Literals(["low", "high", "max"])
export const Thinking = Schema.Struct({ type: Schema.Literals(["enabled", "disabled"]) })

export const matches = (provider: string, model: string) => provider === "deepseek" || /(^|\/)deepseek[-/]/i.test(model)

export const lower = Effect.fn("DeepSeekOptions.lower")(function* (request: LLMRequest) {
  const options = request.providerOptions?.deepseek
  const thinking = options?.thinking ?? { type: "enabled" as const }
  if (!Schema.is(Thinking)(thinking) || Object.keys(thinking).some((key) => key !== "type"))
    return yield* ProviderShared.invalidRequest(
      "DeepSeek thinking accepts only type enabled or disabled; token budgets are unsupported",
    )
  const effort =
    options?.reasoningEffort ?? request.providerOptions?.openai?.reasoningEffort ?? request.http?.body?.reasoning_effort
  if (effort !== undefined && !Schema.is(Effort)(effort))
    return yield* ProviderShared.invalidRequest("DeepSeek reasoning_effort must be low, high or max")
  if (thinking.type === "disabled" && effort !== undefined)
    return yield* ProviderShared.invalidRequest("DeepSeek disabled thinking conflicts with reasoning_effort")
  if (thinking.type === "disabled") return { thinking }
  return { thinking, reasoning_effort: effort ?? ("high" as const) }
})
