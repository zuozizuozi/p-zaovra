import { Option, Schema } from "effect"
import { makeParser } from "effect/unstable/encoding/Sse"

const ObjectValue = Schema.Record(Schema.String, Schema.Unknown)
const parse = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)
const object = Schema.decodeUnknownOption(ObjectValue)
const tokens = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0

/** Observe numeric provider reports only. This neither proves billing nor releases a reservation. */
export function observeUsage(protocol: "openai-chat" | "openai-responses") {
  const decoder = new TextDecoder()
  let reported: { input: number; output: number; total: number } | undefined
  let problem: "invalid-frame" | "invalid-usage" | "conflicting-usage" | undefined
  const parser = makeParser((event) => {
    if (event._tag !== "Event" || event.data.trim() === "[DONE]" || !event.data.trim()) return
    const decoded = parse(event.data)
    const frame = Option.isSome(decoded) ? object(decoded.value) : Option.none()
    if (Option.isNone(frame)) {
      problem ??= "invalid-frame"
      return
    }
    const value = frame.value
    if (
      protocol === "openai-responses" &&
      !["response.completed", "response.incomplete", "response.failed"].includes(String(value.type))
    )
      return
    if (
      protocol === "openai-chat" &&
      (!Array.isArray(value.choices) ||
        !value.choices.every((choice) => {
          const item = object(choice)
          return (
            Option.isSome(item) && typeof item.value.finish_reason === "string" && item.value.finish_reason.length > 0
          )
        }))
    )
      return
    const response = protocol === "openai-responses" ? object(value.response) : frame
    if (Option.isNone(response) || response.value.usage == null) return
    const usage = object(response.value.usage)
    if (Option.isNone(usage)) {
      problem ??= "invalid-usage"
      return
    }
    const input = usage.value[protocol === "openai-chat" ? "prompt_tokens" : "input_tokens"]
    const output = usage.value[protocol === "openai-chat" ? "completion_tokens" : "output_tokens"]
    const total = usage.value.total_tokens ?? (tokens(input) && tokens(output) ? input + output : undefined)
    if (!tokens(input) || !tokens(output) || !tokens(total) || total !== input + output) {
      problem ??= "invalid-usage"
      return
    }
    // Inclusive input/output already include cached input and reasoning output.
    // Never add optional breakdowns to these totals a second time.
    const next = { input, output, total }
    if (reported && (reported.input !== input || reported.output !== output || reported.total !== total)) {
      problem ??= "conflicting-usage"
      return
    }
    reported = next
  })
  return {
    feed(bytes: Uint8Array) {
      parser.feed(decoder.decode(bytes, { stream: true }))
    },
    result() {
      if (problem || !reported) return { status: "unknown" as const, reason: problem ?? "no-terminal-usage" }
      return { status: "reported" as const, ...reported, basis: "provider-terminal-usage" as const }
    },
  }
}
