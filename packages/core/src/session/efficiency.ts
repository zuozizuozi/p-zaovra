export * as SessionEfficiency from "./efficiency"

import { SessionMessage } from "./message"

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
      const key = `${part.name}:${JSON.stringify(part.state.input, (key, value: unknown) => {
        if (key === "description") return undefined
        return value && typeof value === "object" && !Array.isArray(value)
          ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
          : value
      })}`
      const previousCallID = seen.get(key)
      if (previousCallID) repeated.set(key, { tool: part.name, previousCallID, callID: part.id })
      seen.set(key, part.id)
    }
  }
  return [...repeated.values()].slice(-3)
}
