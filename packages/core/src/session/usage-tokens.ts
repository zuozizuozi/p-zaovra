import type { Usage } from "@zaovra-ai/llm"

/** The breakdown is disjoint: reasoning and cache must not be counted twice. */
export function usageTokens(usage: Usage | undefined) {
  const safe = (value: number | undefined) => Math.max(0, Number.isFinite(value) ? (value ?? 0) : 0)
  return {
    input: safe(usage?.nonCachedInputTokens),
    output: safe(usage?.visibleOutputTokens),
    reasoning: safe(usage?.reasoningTokens),
    cache: { read: safe(usage?.cacheReadInputTokens), write: safe(usage?.cacheWriteInputTokens) },
  }
}

export const usageReported = (usage: Usage | undefined) =>
  usage?.inputTokens !== undefined && usage?.outputTokens !== undefined
