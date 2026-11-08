import type { Part } from "@zaovra-ai/sdk/v2"

export function turnPartFoldable(part: Part | undefined, options: { answer: boolean; coveredFailure: boolean }) {
  if (part?.type === "text") return !options.answer
  if (part?.type === "reasoning") return true
  if (part?.type !== "tool") return false
  if (part.tool === "question" && part.state.status !== "completed") return false
  if ("metadata" in part.state && part.state.metadata?.phase === "permission") return false
  return part.state.status !== "error" || options.coveredFailure
}
