import type { AssistantMessage, Message, Part, ToolPart } from "@zaovra-ai/sdk/v2"
import { diagnosticFailures, formattingFailures } from "./formatting-failures"
import { displayTurnOwners } from "./turn-ownership"

/** Display-only evidence. A later successful operation never changes the stored failure or verification verdict. */
export function recoveredToolFailures(input: {
  message: AssistantMessage
  messages: readonly Message[]
  parts: Readonly<Record<string, Part[]>>
  working: boolean
}) {
  const messages = input.messages
    .filter((message) => message.sessionID === input.message.sessionID)
    .toSorted((a, b) => a.time.created - b.time.created || a.id.localeCompare(b.id))
  const owners = displayTurnOwners(messages, (id) => input.parts[id] ?? [])
  messages.forEach((message) => {
    if (message.role === "assistant") owners.set(message.id, owners.get(message.parentID) ?? message.parentID)
  })
  const request = owners.get(input.message.id)
  const active = messages.findLast((message) => message.role === "assistant")
  if (!request || (input.working && active && owners.get(active.id) === request)) return []
  const turn = messages.filter(
    (message): message is AssistantMessage => message.role === "assistant" && owners.get(message.id) === request,
  )
  const last = turn.at(-1)
  if (typeof last?.time.completed !== "number" || !last.finish || last.finish === "tool-calls") return []
  const tools = turn
    .flatMap((message) => input.parts[message.id] ?? [])
    .filter((part): part is ToolPart => part.type === "tool")
  if (tools.some((part) => part.state.status === "pending" || part.state.status === "running")) return []
  return tools.filter((part, index) => {
    if (part.state.status !== "error" || verification(part)) return false
    if (part.tool === "edit" && /^\s*(?:Error:\s*)?No changes to apply:/i.test(part.state.error)) return true
    const metadata = part.state.metadata
    if (/\bOutcome may have occurred\b|\btimeout\b|\btimed out\b|\bpartial/i.test(part.state.error)) return false
    if (metadata?.timeout || (metadata?.phase === "mutation" && metadata.reason !== "match-failed")) return false
    const end = part.state.time.end
    return tools.slice(index + 1).some((success) => {
      if (success.state.status !== "completed" || success.state.time.end < end || verification(success)) return false
      if (formattingFailures(success.state.metadata).length || diagnosticFailures(success.state.metadata).length)
        return false
      if (typeof success.state.metadata.exit === "number" && success.state.metadata.exit !== 0) return false
      if (success.state.metadata.timeout || success.state.metadata.job_id) return false
      return sameOperation(part, success)
    })
  })
}

function verification(part: ToolPart) {
  const metadata = "metadata" in part.state ? part.state.metadata : undefined
  return (
    !!part.state.input.verification ||
    !!part.state.input.verification_report ||
    !!metadata?.verification ||
    !!metadata?.verifications ||
    metadata?.phase === "verification" ||
    (part.state.status === "error" && /\bVerification failed\b/i.test(part.state.error))
  )
}

function sameOperation(failed: ToolPart, success: ToolPart) {
  const input = failed.state.input
  const next = success.state.input
  if (failed.tool === "edit") {
    // Corrected whitespace still identifies the same target. A different block
    // or a write containing the replacement does not prove this edit recovered.
    return (
      success.tool === "edit" &&
      (input.filePath ?? input.path) === (next.filePath ?? next.path) &&
      typeof input.newString === "string" &&
      input.newString.length > 0 &&
      input.newString === next.newString &&
      (input.replaceAll === true) === (next.replaceAll === true) &&
      typeof input.oldString === "string" &&
      typeof next.oldString === "string" &&
      input.oldString.trim().replace(/\s+/g, " ") === next.oldString.trim().replace(/\s+/g, " ")
    )
  }
  // Require the exact operation for other tools; matching only a tool name would conceal unrelated failures.
  return (
    failed.tool === success.tool &&
    Object.keys(input).length > 0 &&
    Object.keys(input).length === Object.keys(next).length &&
    Object.keys(input).every((key) => JSON.stringify(input[key]) === JSON.stringify(next[key]))
  )
}
