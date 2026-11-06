import type { AssistantMessage, Part } from "@zaovra-ai/sdk/v2"
/** Display-only: a completed delivery may retain failed exploratory commands in its process. */
export function processToolFailures(
  messages: readonly AssistantMessage[],
  parts: (id: string) => readonly Part[],
  working: boolean,
) {
  const result = new Set<string>()
  const last = messages.at(-1)
  if (
    working ||
    !last ||
    last.error ||
    last.finish !== "stop" ||
    typeof last.time.completed !== "number" ||
    !parts(last.id).some((part) => part.type === "text" && part.text.trim() && !part.metadata?.superseded)
  )
    return result
  const tools = messages.flatMap((message) => parts(message.id)).filter((part) => part.type === "tool")
  tools.forEach((part, index) => {
    if (
      (part.state.status !== "error" &&
        !(
          part.state.status === "completed" &&
          typeof part.state.metadata.exit === "number" &&
          part.state.metadata.exit !== 0
        )) ||
      !["bash", "bash_job"].includes(part.tool) ||
      part.state.time.end > last.time.completed! ||
      part.state.metadata?.phase === "permission" ||
      part.state.input.verification ||
      part.state.metadata?.verification ||
      part.state.metadata?.verifications ||
      part.state.metadata?.timeout ||
      /\b(?:timeout|timed out|Outcome may have occurred|Verification failed)\b/i.test(
        part.state.status === "error" ? part.state.error : part.state.output,
      )
    )
      return
    const ended = part.state.time.end
    if (
      tools
        .slice(index + 1)
        .some(
          (next) =>
            next.state.status === "completed" &&
            next.state.time.end >= ended &&
            !next.state.metadata.timeout &&
            !next.state.metadata.job_id &&
            (["bash", "bash_job"].includes(next.tool)
              ? next.state.metadata.exit === 0
              : !["question", "todowrite"].includes(next.tool) &&
                (next.state.metadata.exit === undefined || next.state.metadata.exit === 0)),
        )
    )
      result.add(part.id)
  })
  return result
}
