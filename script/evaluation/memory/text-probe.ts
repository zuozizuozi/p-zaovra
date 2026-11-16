import { createHash } from "node:crypto"
import { Effect, Option, Schema, Stream } from "effect"
import { Sse } from "effect/unstable/encoding"
import { usageNumbers } from "../../../packages/llm/src/route/diagnostics"
import { startEvaluationRelay } from "./relay"

/** One synthetic transport probe, no tools, no retry, no automatic budget settlement.
 * Caller must record its authorized estimate BEFORE invoking this function. This does
 * not establish a supplier token hard bound or prove the product's Session path works.
 */
export async function probeEvaluationText(input: {
  baseURL: string
  apiKey: string
  model: string
  protocol: "openai-chat" | "openai-responses"
  journal: string
  deadlineMs?: number
}) {
  const deadline = input.deadlineMs ?? 60000
  if (!Number.isSafeInteger(deadline) || deadline < 1 || deadline > 60000) throw new Error("invalid-probe-deadline")
  const relay = startEvaluationRelay({ ...input, maxRequests: 1, maxRequestBytes: 4096, maxOutput: 256 })
  const controller = new AbortController()
  const started = Date.now()
  const timer = setTimeout(() => controller.abort(), deadline)
  const body = JSON.stringify(
    input.protocol === "openai-responses"
      ? {
          model: input.model,
          stream: true,
          input: [
            { type: "message", role: "user", content: [{ type: "input_text", text: "Reply with exactly READY." }] },
          ],
          max_output_tokens: 256,
        }
      : {
          model: input.model,
          stream: true,
          messages: [{ role: "user", content: "Reply with exactly READY." }],
          max_tokens: 256,
          stream_options: { include_usage: true },
        },
  )
  const result = {
    protocol: input.protocol,
    model: input.model,
    responseModels: [] as string[],
    responseModelStatus: "not-reported",
    request: {
      bytes: Buffer.byteLength(body),
      sha256: createHash("sha256").update(body).digest("hex"),
      maxOutput: 256,
      tools: false,
    },
    status: null as number | null,
    reason: "not-sent",
    pass: false,
    usage: { status: "unsettled", reserve: "retain", observations: [] as Record<string, unknown>[] },
    elapsedMs: 0,
  }
  try {
    const response = await fetch(
      relay.baseURL + (input.protocol === "openai-responses" ? "/responses" : "/chat/completions"),
      {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${relay.apiKey}` },
        body,
      },
    )
    result.status = response.status
    if (!response.ok) {
      await response.body?.cancel()
      result.reason = "http-failed"
      return result
    }
    if (!response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream")) {
      await response.body?.cancel()
      result.reason = "unexpected-content-type"
      return result
    }
    // The relay bounds the whole response at 4MiB before this allocation completes.
    const text = new TextDecoder("utf-8", { fatal: true }).decode(await response.arrayBuffer())
    const frames = await Effect.runPromise(
      Stream.make(text).pipe(Stream.pipeThroughChannel(Sse.decode()), Stream.runCollect),
    )
    const values: Record<string, unknown>[] = []
    let done = false
    for (const frame of frames) {
      if (!frame.data) continue
      if (done) throw new Error("data-after-done")
      if (frame.data === "[DONE]") {
        done = true
        continue
      }
      const decoded = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(frame.data)
      if (Option.isNone(decoded) || !record(decoded.value)) throw new Error("invalid-event")
      values.push(decoded.value)
    }
    result.usage.observations = values.flatMap((value) => {
      const usage = input.protocol === "openai-responses" && record(value.response) ? value.response.usage : value.usage
      return record(usage) ? [usageNumbers(usage)] : []
    })
    // These are provider-supplied labels, not authentication of the underlying model.
    // Keep text success separate so a READY reply cannot silently prove model identity.
    const models = values.flatMap((value) => {
      const response = input.protocol === "openai-responses" ? value.response : value
      return record(response) && response.model !== undefined ? [response.model] : []
    })
    const labels = models.filter(
      (model): model is string =>
        typeof model === "string" && /^[A-Za-z0-9_.:/-]{1,160}$/.test(model) && !model.includes(input.apiKey),
    )
    result.responseModels = [...new Set(labels)]
    result.responseModelStatus =
      labels.length !== models.length
        ? "invalid-label"
        : result.responseModels.length > 1
          ? "conflicting-labels"
          : result.responseModels.length === 1
            ? "reported-label"
            : "not-reported"
    const answer = input.protocol === "openai-responses" ? responses(values) : chat(values, done)
    result.pass = answer === "READY"
    result.reason =
      answer === undefined ? "incomplete-or-invalid-stream" : result.pass ? "expected-text-matched" : "unexpected-text"
    return result
  } catch {
    result.reason = controller.signal.aborted ? "deadline" : "transport-or-invalid-stream"
    return result
  } finally {
    clearTimeout(timer)
    controller.abort()
    await relay.stop()
    result.elapsedMs = Date.now() - started
  }
}

function chat(values: Record<string, unknown>[], done: boolean) {
  if (!done) return
  let finished = false
  const text: string[] = []
  for (const value of values) {
    if (value.error || !Array.isArray(value.choices) || value.choices.length > 1) return
    for (const choice of value.choices) {
      if (!record(choice) || choice.index !== 0 || !record(choice.delta) || finished) return
      if (choice.delta.tool_calls || choice.delta.function_call) return
      if (choice.delta.content != null) {
        if (typeof choice.delta.content !== "string") return
        text.push(choice.delta.content)
      }
      if (choice.finish_reason != null) {
        if (choice.finish_reason !== "stop") return
        finished = true
      }
    }
  }
  if (finished) return text.join("")
}

function responses(values: Record<string, unknown>[]) {
  if (values.some((value) => ["error", "response.failed", "response.incomplete"].includes(String(value.type)))) return
  const finals = values.filter((value) => value.type === "response.completed")
  if (finals.length !== 1 || values.at(-1) !== finals[0]) return
  const response = finals[0]!.response
  if (!record(response) || response.status !== "completed" || response.error || !Array.isArray(response.output)) return
  const text: string[] = []
  for (const item of response.output) {
    if (!record(item)) return
    if (item.type === "reasoning") continue
    if (item.type !== "message" || item.role !== "assistant" || !Array.isArray(item.content)) return
    for (const part of item.content) {
      if (!record(part) || part.type !== "output_text" || typeof part.text !== "string") return
      text.push(part.text)
    }
  }
  return text.join("")
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
