import type { Message, Part } from "@zaovra-ai/sdk/v2"
import { Feedback } from "@zaovra-ai/schema/feedback"

/** Project only diagnostic fields; conversation and provider bodies remain opt-in. */
export function sessionFeedback(messages: readonly Message[], parts: (id: string) => readonly Part[], now: number) {
  const recent = messages.toSorted((a, b) => a.time.created - b.time.created || a.id.localeCompare(b.id)).slice(-50)
  const errors = recent.flatMap((message) => {
    if (message.role !== "assistant" || !message.error) return []
    const data = message.error.data
    const text = data && "message" in data && typeof data.message === "string" ? data.message : message.error.name
    const api = message.error.name === "APIError" ? message.error.data : undefined
    const metadata = api?.metadata
    const headers = api?.responseHeaders
    const status = api?.statusCode
    const requestID = [
      metadata?.requestID,
      metadata?.request_id,
      metadata?.["x-request-id"],
      ...Object.entries(headers ?? {}).flatMap(([key, value]) =>
        /^(?:x-request-id|request-id|x-amzn-requestid)$/i.test(key) ? [value] : [],
      ),
      /\brequest[_ -]?id\s*[:=]\s*["']?([\w.:-]{1,128})/i.exec(text)?.[1],
    ].find((value) => typeof value === "string" && value.length > 0)
    return [
      {
        at: message.time.completed ?? message.time.created,
        status: status ?? (metadata?.statusCode ? Number(metadata.statusCode) : undefined),
        diagnosticMessage: Feedback.redact(text.slice(0, 2000)),
        ...Feedback.providerDiagnostic({ code: metadata?.providerCode, message: metadata?.providerMessage }),
        requestID: requestID ? Feedback.redact(requestID.slice(0, 128)) : undefined,
        category: Feedback.suggestion(text),
      },
    ]
  })
  const tools = recent.flatMap((message) => parts(message.id)).filter((part) => part.type === "tool")
  const latest = recent.findLast((message) => message.role === "assistant")
  return {
    error: errors.findLast((item) => item.at >= now - 1_800_000 && item.at <= now)?.diagnosticMessage,
    context: {
      provider: latest?.providerID,
      model: latest?.modelID,
      events: [
        ...recent.map((message) => ({
          at: message.role === "assistant" ? (message.time.completed ?? message.time.created) : message.time.created,
          kind: "message",
          state:
            message.role === "assistant"
              ? message.error
                ? "error"
                : message.time.completed === undefined
                  ? "running"
                  : "completed"
              : "info",
        })),
        ...tools.map((part) => ({
          at:
            part.state.status === "completed" || part.state.status === "error"
              ? part.state.time.end
              : part.state.status === "running"
                ? part.state.time.start
                : 0,
          kind: part.tool,
          state: part.state.status,
        })),
      ]
        .toSorted((a, b) => a.at - b.at)
        .slice(-50),
      errors: [
        ...errors.map((item) => ({
          at: item.at,
          status: item.status,
          requestID: item.requestID,
          category: item.category,
          ...Feedback.providerDiagnostic({ code: item.providerCode, message: item.providerMessage }),
        })),
        ...tools.flatMap((part) =>
          part.state.status === "error"
            ? [{ at: part.state.time.end, category: Feedback.suggestion(part.state.error) }]
            : [],
        ),
      ]
        .toSorted((a, b) => a.at - b.at)
        .slice(-20),
    } satisfies Feedback.Context,
  }
}
