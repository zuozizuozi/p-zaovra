import type { AssistantMessage, Message, Part, ToolPart } from "@zaovra-ai/sdk/v2"
import { SessionToolDisposition } from "@zaovra-ai/schema/session-tool-disposition"

type RecoveryInput = {
  message: AssistantMessage
  messages: readonly Message[]
  parts: Readonly<Record<string, Part[]>>
  working: boolean
  historyComplete?: boolean
}

/** Read the persisted verdict, never infer recovery from the visible page. */
export function toolFailureDisposition(message: AssistantMessage | undefined, part: Part) {
  if (!message || part.type !== "tool" || part.state.status !== "error") return
  const report = SessionToolDisposition.read(part.failureDisposition, part.settledSeq)
  if (
    !report ||
    !message.turn ||
    !Number.isSafeInteger(message.seq) ||
    message.seq! < 0 ||
    !Number.isSafeInteger(part.settledSeq) ||
    part.settledSeq! < message.seq! ||
    report.basisSeq < part.settledSeq! ||
    report.sessionID !== message.sessionID ||
    part.sessionID !== message.sessionID ||
    report.assistantMessageID !== message.id ||
    part.messageID !== message.id ||
    report.callID !== part.callID ||
    report.turnID !== message.turn
  )
    return
  return report
}

export function toolExecutionInterrupted(message: AssistantMessage | undefined, part: Part) {
  return toolFailureDisposition(message, part)?.status === "interrupted"
}

/** Only a live backend status and the current durable turn may quiet pending evidence. */
export function toolFailureInProgress(input: RecoveryInput) {
  if (!input.working || !input.message.turn || !Number.isSafeInteger(input.message.seq) || input.message.seq! < 0)
    return false
  const current = input.messages
    .filter(
      (message) =>
        message.sessionID === input.message.sessionID &&
        Number.isSafeInteger(message.seq) &&
        message.seq! >= 0 &&
        message.turn &&
        (message.role === "assistant" || message.turn === message.id),
    )
    .toSorted((a, b) => a.seq! - b.seq!)
    .at(-1)
  return (
    !!current &&
    current.turn === input.message.turn &&
    (current.role === "user" || current.time.completed === undefined || current.finish === "tool-calls")
  )
}

export function recoveredToolFailures(input: RecoveryInput): ToolPart[] {
  return (input.parts[input.message.id] ?? []).filter(
    (part): part is ToolPart =>
      part.type === "tool" && toolFailureDisposition(input.message, part)?.status === "recovered",
  )
}

export function quietToolFailures(input: RecoveryInput): ToolPart[] {
  return (input.parts[input.message.id] ?? []).filter((part): part is ToolPart => {
    const status = toolFailureDisposition(input.message, part)?.status
    return part.type === "tool" && (status === "recovered" || status === "exploratory" || status === "interrupted")
  })
}
