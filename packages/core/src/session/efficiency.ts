export * as SessionEfficiency from "./efficiency"

import { SessionMessage } from "./message"

/** Only known, top-level observation fields are excluded from execution identity. */
export function fingerprint(tool: string, input: unknown) {
  const ignored =
    tool === "bash"
      ? ["description", "progress_hypothesis", "progress_expected_evidence"]
      : ["read", "glob", "grep"].includes(tool)
        ? ["description"]
        : []
  const execution =
    input && typeof input === "object" && !Array.isArray(input)
      ? Object.fromEntries(Object.entries(input).filter(([key]) => !ignored.includes(key)))
      : input
  return `${tool}:${JSON.stringify(execution, (_key, value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
      : value,
  )}`
}

/** Advisory only: equal commands do not prove equal filesystem/process state. */
export function repeatedInspection(messages: readonly SessionMessage.Message[]) {
  const turn = messages.slice(
    Math.max(
      0,
      messages.findLastIndex((message) => message.type === "user"),
    ),
  )
  if (turn.some((message) => message.type === "synthetic" && message.text.startsWith("Repeated inspection review:")))
    return []
  const seen = new Map<string, string>()
  const repeated = new Map<string, { tool: string; previousCallID: string; callID: string }>()
  for (const message of turn) {
    if (message.type !== "assistant") continue
    for (const part of message.content) {
      if (part.type !== "tool" || part.provider?.executed) continue
      if (["write", "edit", "apply_patch"].includes(part.name)) {
        seen.clear()
        repeated.clear()
        continue
      }
      if (part.state.status !== "completed" || !["read", "glob", "grep", "bash"].includes(part.name)) continue
      const key = fingerprint(part.name, part.state.input)
      const previousCallID = seen.get(key)
      if (previousCallID) repeated.set(key, { tool: part.name, previousCallID, callID: part.id })
      seen.set(key, part.id)
    }
  }
  return [...repeated.values()].slice(-3)
}
