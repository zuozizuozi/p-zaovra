export * as SessionOutcome from "./outcome"

import { Schema, Option } from "effect"
import { SessionOutcome } from "@zaovra-ai/schema/session-outcome"
import { SessionMessage } from "./message"

export function derive(
  messages: readonly SessionMessage.Message[],
  active: boolean,
  snapshot?: string,
): SessionOutcome.Info {
  const start = messages.findLastIndex((message) => message.type === "user")
  const turn = messages.slice(Math.max(0, start))
  const last = turn.findLast((message) => message.type === "assistant")
  const checks = new Map<string, SessionOutcome.Check>()
  for (const message of turn) {
    if (message.type !== "assistant") continue
    for (const part of message.content) {
      if (part.type !== "tool" || part.name !== "bash" || part.provider?.executed) continue
      if (part.state.status === "error") {
        const command = typeof part.state.input.command === "string" ? part.state.input.command : ""
        const kind =
          part.state.input.verification ??
          command.match(/^(?:bun|npm|pnpm|yarn)(?: run)? (build|test|lint|typecheck)(?:\s+[^;&|<>]*)?$/)?.[1]
        const failed = Schema.decodeUnknownOption(SessionOutcome.Check)({ kind, command, exit: -1, callID: part.id })
        if (Option.isSome(failed)) checks.set(failed.value.kind, failed.value)
      }
      if (part.state.status !== "completed") continue
      const value = part.state.structured.verification
      const decoded = Schema.decodeUnknownOption(SessionOutcome.Check)(value)
      if (Option.isSome(decoded) && decoded.value.callID === part.id) checks.set(decoded.value.kind, decoded.value)
    }
  }
  const missing = ["build", "test", "lint"].filter((kind) => {
    const check = checks.get(kind)
    return !check || check.exit !== 0 || !snapshot || check.snapshot !== snapshot
  })
  const unknown = turn.some(
    (message) =>
      (message.type === "shell" && message.time.completed === undefined) ||
      (message.type === "assistant" &&
        (message.time.completed === undefined ||
          message.content.some(
            (part) => part.type === "tool" && (part.state.status === "pending" || part.state.status === "running"),
          ))),
  )
  const base = { outcomeUnknown: !active && unknown, checks: [...checks.values()], missing, messageID: turn.at(-1)?.id }
  if (active) return { ...base, state: "running" }
  if (unknown || last?.finish === "interrupted") return { ...base, state: "interrupted" }
  if (!last) return { ...base, state: start >= 0 ? "interrupted" : "idle" }
  if (last.error || last.finish !== "stop") return { ...base, state: "failed" }
  if ([...checks.values()].some((check) => check.exit !== 0)) return { ...base, state: "failed" }
  return { ...base, state: missing.length ? "completed_unverified" : "completed_verified" }
}
