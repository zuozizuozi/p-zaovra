export * as MemoryTidyBudget from "./tidy-budget"

import { Context, Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { InvalidRequestReason, LLMError, QuotaExceededReason, type Usage } from "@zaovra-ai/llm"
import type { CompletedAttempt } from "@zaovra-ai/llm/route"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { MemoryTidyStore } from "./tidy-store"
import { MemoryTidyAttemptTable } from "./tidy.sql"

export interface Interface {
  /** A completed parser receipt can settle only its own admitted physical attempt. */
  readonly complete: (runID: string, receipt: CompletedAttempt) => Effect.Effect<"settled" | "unknown", LLMError>
}

export class Service extends Context.Service<Service, Interface>()("@zaovra/MemoryTidyBudget") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const store = yield* MemoryTidyStore.Service
    return Service.of({
      complete: Effect.fn("MemoryTidyBudget.complete")(function* (runID, receipt) {
        const attempt = yield* database.db
          .select({ runID: MemoryTidyAttemptTable.run_id })
          .from(MemoryTidyAttemptTable)
          .where(eq(MemoryTidyAttemptTable.id, receipt.id))
          .get()
          .pipe(Effect.orDie)
        if (attempt?.runID !== runID)
          return yield* new LLMError({
            module: "MemoryTidyBudget",
            method: "complete",
            reason: new InvalidRequestReason({ message: "整理请求的用量回执没有对应的本次预算预留。" }),
          })
        const actual = reported(receipt.request.model.route.protocol, receipt.usage)
        // A parser can synthesize finish at EOF. Missing/inconsistent native
        // usage is not evidence that the provider did no billable work.
        if (actual === undefined) return "unknown"
        const settled = yield* store.settle(receipt.id, actual).pipe(
          Effect.mapError(
            (error) =>
              new LLMError({
                module: "MemoryTidyBudget",
                method: "complete",
                reason: new InvalidRequestReason({ message: `整理用量未能结算：${error.reason}。` }),
              }),
          ),
        )
        if (settled.exceeded)
          return yield* new LLMError({
            module: "MemoryTidyBudget",
            method: "complete",
            reason: new QuotaExceededReason({ message: "整理请求的实际用量超过预留，已记入用量并停止本次整理。" }),
          })
        return "settled"
      }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node, MemoryTidyStore.node] })

/** Inclusive native input/output counts; cache and reasoning are subsets. */
export function reported(protocol: string, usage: Usage | undefined) {
  if (!usage) return
  if (protocol !== "openai-chat" && protocol !== "openai-responses") return
  const raw = usage.providerMetadata?.openai
  if (!record(raw)) return
  const chat = protocol === "openai-chat"
  const input = chat
    ? (raw.prompt_tokens ??
      (token(raw.prompt_cache_hit_tokens) && token(raw.prompt_cache_miss_tokens)
        ? raw.prompt_cache_hit_tokens + raw.prompt_cache_miss_tokens
        : undefined))
    : raw.input_tokens
  const output = chat ? raw.completion_tokens : raw.output_tokens
  if (!token(input) || !token(output) || !token(input + output)) return
  if (raw.total_tokens != null && raw.total_tokens !== input + output) return
  if (usage.inputTokens !== input || usage.outputTokens !== output) return
  if (usage.totalTokens !== undefined && usage.totalTokens !== input + output) return

  const inputDetails = chat ? raw.prompt_tokens_details : raw.input_tokens_details
  const outputDetails = chat ? raw.completion_tokens_details : raw.output_tokens_details
  if (inputDetails != null && !record(inputDetails)) return
  if (outputDetails != null && !record(outputDetails)) return
  const cached = record(inputDetails) ? inputDetails.cached_tokens : undefined
  const reasoning = record(outputDetails) ? outputDetails.reasoning_tokens : undefined
  if (!subset(cached, input) || !subset(reasoning, output)) return
  if (!subset(usage.cacheReadInputTokens, input) || !subset(usage.reasoningTokens, output)) return
  if (!subset(usage.nonCachedInputTokens, input)) return
  // These protocols have no separately additive cache-write axis. Unknown
  // extensions must not silently disappear from a budget settlement.
  if (usage.cacheWriteInputTokens !== undefined && usage.cacheWriteInputTokens !== 0) return
  if (cached != null && usage.cacheReadInputTokens !== cached) return
  if (reasoning != null && usage.reasoningTokens !== reasoning) return
  if (
    usage.cacheReadInputTokens !== undefined &&
    usage.nonCachedInputTokens !== undefined &&
    usage.cacheReadInputTokens + usage.nonCachedInputTokens !== input
  )
    return
  if (chat) {
    if (!subset(raw.prompt_cache_hit_tokens, input) || !subset(raw.prompt_cache_miss_tokens, input)) return
    if (
      token(raw.prompt_cache_hit_tokens) &&
      token(raw.prompt_cache_miss_tokens) &&
      raw.prompt_cache_hit_tokens + raw.prompt_cache_miss_tokens !== input
    )
      return
    if (cached != null && raw.prompt_cache_hit_tokens != null && cached !== raw.prompt_cache_hit_tokens) return
    if (raw.prompt_cache_hit_tokens != null && usage.cacheReadInputTokens !== raw.prompt_cache_hit_tokens) return
    if (raw.prompt_cache_miss_tokens != null && usage.nonCachedInputTokens !== raw.prompt_cache_miss_tokens) return
  }
  return input + output
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function token(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function subset(value: unknown, total: number) {
  return value == null || (token(value) && value <= total)
}
