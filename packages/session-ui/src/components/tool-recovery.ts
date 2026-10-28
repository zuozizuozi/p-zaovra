import type { AssistantMessage, Message, Part, ToolPart } from "@zaovra-ai/sdk/v2"
import { SessionRequest } from "@zaovra-ai/schema/session-request"
import { diagnosticFailures, formattingFailures } from "./formatting-failures"
import { displayTurnOwners, isContinuation } from "./turn-ownership"

/** Display-only evidence. A later successful operation never changes the stored failure or verification verdict. */
type RecoveryInput = {
  message: AssistantMessage
  messages: readonly Message[]
  parts: Readonly<Record<string, Part[]>>
  working: boolean
}

function settledTools(input: RecoveryInput) {
  const messages = input.messages
    .filter((message) => message.sessionID === input.message.sessionID)
    .toSorted((a, b) => a.time.created - b.time.created || a.id.localeCompare(b.id))
  const owners = displayTurnOwners(messages, (id) => input.parts[id] ?? [])
  messages.forEach((message) => {
    if (message.role === "assistant") owners.set(message.id, owners.get(message.parentID) ?? message.parentID)
  })
  const request = owners.get(input.message.id)
  const active = messages.findLast((message) => message.role === "assistant")
  if (!request || (input.working && active && owners.get(active.id) === request)) return
  const turn = messages.filter(
    (message): message is AssistantMessage => message.role === "assistant" && owners.get(message.id) === request,
  )
  const last = turn.at(-1)
  if (typeof last?.time.completed !== "number" || !last.finish || last.finish === "tool-calls") return
  const tools = turn
    .flatMap((message) => input.parts[message.id] ?? [])
    .filter((part): part is ToolPart => part.type === "tool")
  if (tools.some((part) => part.state.status === "pending" || part.state.status === "running")) return
  return { tools, last, request, messages }
}

export function recoveredToolFailures(input: RecoveryInput) {
  const tools = settledTools(input)?.tools
  return tools
    ? recoveries(tools).filter((part) => part.tool !== "read" || quietToolFailures(input).includes(part))
    : []
}

function recoveries(tools: ToolPart[]) {
  return tools.filter((part, index) => {
    if (part.state.status !== "error" || verification(part)) return false
    if (part.tool === "read" && part.state.metadata?.readFailure !== "not_found") return false
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

/** Exploratory misses are quiet only after a successful alternative, never merely because prose claims success. */
export function quietToolFailures(input: RecoveryInput) {
  const settled = settledTools(input)
  const recovered = settled ? recoveries(settled.tools).filter((part) => part.tool !== "read") : []
  if (!settled || settled.last.error || settled.last.finish !== "stop") return recovered
  if (!(input.parts[settled.last.id] ?? []).some((part) => part.type === "text" && part.text.trim())) return recovered
  const agents = new Map(
    input.messages.filter((message) => message.role === "assistant").map((message) => [message.id, message.agent]),
  )
  const users = (
    settled.tools.some(
      (part) =>
        part.tool === "read" && part.state.status === "error" && part.state.metadata?.readFailure === "not_found",
    )
      ? settled.messages
      : []
  )
    .slice(0, settled.messages.findIndex((message) => message.id === settled.request) + 1)
    .filter((message) => message.role === "user" && !isContinuation(input.parts[message.id] ?? []))
    .map((message) => {
      const parts = input.parts[message.id] ?? []
      const text = parts.filter(
        (part): part is Extract<Part, { type: "text" }> => part.type === "text" && !part.synthetic,
      )
      const source = text.find((part) => typeof part.metadata?.zaovraRequestText === "string")?.metadata
      return {
        id: message.id,
        type: "user",
        text:
          typeof source?.zaovraRequestText === "string"
            ? source.zaovraRequestText
            : text.map((part) => part.text).join("\n"),
        visibleText: text.map((part) => part.text).join("\n"),
        files: parts.filter((part) => part.type === "file"),
        agents: parts.filter((part) => part.type === "agent"),
        subtask: source?.zaovraRequestSubtask,
        invocation: source?.zaovraRequestInvocation,
      }
    })
  const requested = SessionRequest.requested(users, () => "")
  const scope = users.slice(users.findIndex((message) => message.id === requested.sourceMessageID))
  // Missing request pages or opaque attachment/delegation sources cannot prove a file was unrequested.
  const request =
    scope.length &&
    scope.every((message) => message.text.trim() && !message.files.length && !message.agents.length && !message.subtask)
      ? requested
      : undefined
  const sources = new Set(request?.entries.map((entry) => entry.sourceMessageID))
  // Match the source text, so punctuation in a filename cannot be split across clauses.
  const originalText = request
    ? scope
        .filter((message) => sources.has(message.id))
        .flatMap((message) => [
          message.text,
          message.visibleText,
          ...(typeof message.invocation === "string" ? [message.invocation] : []),
        ])
    : undefined
  const exploratory = (part: ToolPart) =>
    part.state.status === "error" &&
    !verification(part) &&
    !uncertain(part) &&
    (part.tool === "read"
      ? part.state.metadata?.readFailure === "not_found"
      : ["list", "glob", "grep", "websearch"].includes(part.tool) &&
        /\b(?:ENOENT|file not found|no such file|does not exist|no (?:results|matches)(?: found)?)\b/i.test(
          part.state.error,
        ))
  // An unresolved verification, mutation, permission or unknown error prevents an outcome-neutral claim.
  if (
    settled.tools.some(
      (part) =>
        (part.state.status === "error" && !recovered.includes(part) && !exploratory(part)) ||
        (part.state.status === "completed" &&
          (formattingFailures(part.state.metadata).length > 0 ||
            diagnosticFailures(part.state.metadata).length > 0 ||
            !!part.state.metadata.timeout ||
            !!part.state.metadata.job_id ||
            (typeof part.state.metadata.exit === "number" && part.state.metadata.exit !== 0) ||
            (verification(part) && (part.state.metadata.exit !== 0 || !!part.state.metadata.execution)))),
    )
  )
    return recovered
  return settled.tools.filter((part, index, tools) => {
    if (recovered.includes(part)) return true
    if (part.state.status !== "error" || !exploratory(part)) return false
    const path = part.state.input.path ?? part.state.input.filePath
    const filename = typeof path === "string" ? path.split(/[\\/]/).at(-1)?.trim().toLowerCase() : undefined
    const unrequested =
      originalText &&
      filename &&
      filename !== "." &&
      filename !== ".." &&
      !originalText.some((text) => text.replaceAll("\\", "/").toLowerCase().includes(filename))
    const end = part.state.time.end
    return tools
      .slice(index + 1)
      .some(
        (next) =>
          next.state.status === "completed" &&
          next.state.time.end >= end &&
          (part.tool !== "read" ||
            ((next.tool === "read" || (next.tool === "write" && unrequested)) &&
              typeof (part.state.input.path ?? part.state.input.filePath) === "string" &&
              !!(part.state.input.path ?? part.state.input.filePath) &&
              (part.state.input.path ?? part.state.input.filePath) ===
                (next.state.input.path ?? next.state.input.filePath) &&
              !!agents.get(part.messageID) &&
              agents.get(part.messageID) === agents.get(next.messageID))) &&
          !next.state.metadata.timeout &&
          !next.state.metadata.job_id &&
          (typeof next.state.metadata.exit !== "number" || next.state.metadata.exit === 0),
      )
  })
}

function uncertain(part: ToolPart) {
  const metadata = "metadata" in part.state ? part.state.metadata : undefined
  return (
    (part.state.status === "error" &&
      /\bOutcome may have occurred\b|\btimeout\b|\btimed out\b|\bpartial|\bpermission denied\b|\baccess denied\b|\bEACCES\b|\bEPERM\b/i.test(
        part.state.error,
      )) ||
    !!metadata?.timeout ||
    !!metadata?.job_id ||
    (metadata?.phase === "mutation" && metadata.reason !== "match-failed")
  )
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
