// Preserve the old UI counterexamples as native Core tests. This only builds
// explicit stored turn/sequence fixtures; the production classifier decides them.
import type { AssistantMessage, Message, Part, ToolPart } from "@zaovra-ai/sdk/v2"
import { Schema } from "effect"
import { SessionMessage } from "@zaovra-ai/schema/session-message"
import { ToolDisposition } from "@zaovra-ai/core/session/tool-disposition"

type Input = {
  message: AssistantMessage
  messages: readonly Message[]
  parts: Readonly<Record<string, Part[]>>
  working: boolean
  historyComplete?: boolean
}

function reports(input: Input) {
  const messages = input.messages.toSorted((a, b) => a.time.created - b.time.created)
  const owners = new Map<string, string>()
  messages.forEach((message, index) => {
    if (message.role === "assistant") {
      owners.set(message.id, owners.get(message.parentID) ?? message.parentID)
      return
    }
    const parts = input.parts[message.id] ?? []
    const synthetic = parts.length > 0 && parts.every((part) => part.type === "text" && part.synthetic)
    owners.set(message.id, synthetic ? (owners.get(messages[index - 1]?.id) ?? message.id) : message.id)
  })
  const active = messages.findLast((message) => message.role === "assistant")
  const history = messages.map((message) => {
    const parts = input.parts[message.id] ?? []
    const turn = `msg_${owners.get(message.id)}`
    const base = { id: `msg_${message.id}`, seq: Math.floor(message.time.created * 10), turn, time: message.time }
    if (message.role === "user") {
      const text = parts.filter((part) => part.type === "text")
      const source = text.find((part) => typeof part.metadata?.zaovraRequestText === "string")?.metadata
      const visible = text.map((part) => part.text).join("\n")
      if (text.length > 0 && text.every((part) => part.synthetic))
        return Schema.decodeUnknownSync(SessionMessage.Synthetic)({
          ...base,
          type: "synthetic",
          sessionID: "ses_legacy",
          text: visible,
        })
      return Schema.decodeUnknownSync(SessionMessage.User)({
        ...base,
        type: "user",
        text: source?.zaovraRequestText ?? visible,
        ...(source ? { invocation: source.zaovraRequestInvocation ?? visible } : {}),
        files: parts.filter((part) => part.type === "file").map((part) => ({ uri: part.url, mime: part.mime })),
        agents: parts.filter((part) => part.type === "agent").map((part) => ({ name: part.name })),
        ...(source?.zaovraRequestSubtask
          ? { subtask: { agent: "build", command: "task", model: { id: "offline", providerID: "fixture" } } }
          : {}),
      })
    }
    return Schema.decodeUnknownSync(SessionMessage.Assistant)({
      ...base,
      type: "assistant",
      agent: message.agent,
      model: { id: message.modelID, providerID: message.providerID },
      finish: message.finish,
      ...(message.error ? { error: { type: "unknown", message: "failed" } } : {}),
      time: input.working && active?.id === message.id ? { created: message.time.created } : message.time,
      content: parts.flatMap((part): unknown[] => {
        if (part.type === "text") return [{ type: "text", id: part.id, text: part.text }]
        if (part.type !== "tool") return []
        const state = part.state
        return [
          {
            type: "tool",
            id: part.callID,
            name: part.tool,
            time: {
              created: message.time.created,
              ...("time" in state
                ? { ran: state.time.start, ...("end" in state.time ? { completed: state.time.end } : {}) }
                : {}),
            },
            ...(state.status === "error" || state.status === "completed"
              ? { settledSeq: Math.floor(state.time.end * 10) }
              : {}),
            state:
              state.status === "pending"
                ? { status: "pending", input: state.raw }
                : {
                    status: state.status,
                    input: state.input,
                    structured: state.metadata ?? {},
                    content: state.status === "completed" ? [{ type: "text", text: state.output }] : [],
                    ...(state.status === "error" ? { error: { type: "unknown", message: state.error } } : {}),
                  },
            ...(state.status === "error"
              ? {
                  failureDisposition: {
                    version: 1,
                    sessionID: "ses_legacy",
                    turnID: turn,
                    assistantMessageID: base.id,
                    callID: part.callID,
                    basisSeq: 1000,
                    status: "unknown",
                    reason: "invalidated",
                  },
                }
              : {}),
          },
        ]
      }),
    })
  })
  return ToolDisposition.classify("ses_legacy", history).filter(
    (report) => report.turnID === `msg_${owners.get(input.message.id)}`,
  )
}

export function quietToolFailures(input: Input): ToolPart[] {
  const verdicts = reports(input).filter((report) => report.status === "recovered" || report.status === "exploratory")
  return input.messages.flatMap((message) =>
    (input.parts[message.id] ?? []).filter(
      (part): part is ToolPart =>
        part.type === "tool" &&
        verdicts.some((report) => report.assistantMessageID === `msg_${message.id}` && report.callID === part.callID),
    ),
  )
}

export function recoveredToolFailures(input: Input): ToolPart[] {
  const verdicts = reports(input).filter((report) => report.status === "recovered" || report.reason === "no-changes")
  return quietToolFailures(input).filter((part) =>
    verdicts.some((report) => report.assistantMessageID === `msg_${part.messageID}` && report.callID === part.callID),
  )
}
