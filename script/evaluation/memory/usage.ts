import { Option, Schema } from "effect"
import { makeParser } from "effect/unstable/encoding/Sse"

const ObjectValue = Schema.Record(Schema.String, Schema.Unknown)
const parse = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)
const object = Schema.decodeUnknownOption(ObjectValue)
const tokens = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0

/** Numeric reports and bounded labels are separate observations, neither billing nor model authentication. */
export function observeUsage(protocol: "openai-chat" | "openai-responses", sensitive: readonly string[] = []) {
  const decoder = new TextDecoder()
  const labels = new Set<string>()
  let invalidLabel = false
  let terminal = false
  let line = false
  let pending = false
  let carriage = false
  let completeBytes: boolean | undefined
  let reported: { input: number; output: number; total: number } | undefined
  let problem: "invalid-frame" | "invalid-usage" | "conflicting-usage" | undefined
  const parser = makeParser((event) => {
    if (event._tag !== "Event" || !event.data.trim()) return
    if (event.data.trim() === "[DONE]") {
      if (protocol === "openai-chat") terminal = true
      return
    }
    const decoded = parse(event.data)
    const frame = Option.isSome(decoded) ? object(decoded.value) : Option.none()
    if (Option.isNone(frame)) {
      problem ??= "invalid-frame"
      invalidLabel = true
      return
    }
    const value = frame.value
    // Observe labels before the numeric usage terminal-frame filter. No text/tool data is retained.
    const source = protocol === "openai-responses" ? object(value.response) : frame
    if (Option.isSome(source) && Object.hasOwn(source.value, "model")) {
      const label = source.value.model
      if (
        typeof label !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9_.\/-]{0,159}$/.test(label) ||
        /^(?:sk-|www\.)/i.test(label) ||
        /\.(?:com|net|org|io|dev|ai)(?:$|\/)/i.test(label) ||
        /\.[A-Za-z]{2,}\//.test(label) ||
        sensitive.some((secret) => secret.length > 0 && label.includes(secret))
      )
        invalidLabel = true
      else if (!invalidLabel) {
        labels.add(label)
        if (labels.size > 4) invalidLabel = true
      }
      if (invalidLabel) labels.clear()
    }
    if (
      protocol === "openai-responses"
        ? ["response.completed", "response.incomplete", "response.failed"].includes(String(value.type))
        : Array.isArray(value.choices) &&
          value.choices.some((choice) => {
            const item = object(choice)
            return (
              Option.isSome(item) && typeof item.value.finish_reason === "string" && item.value.finish_reason.length > 0
            )
          })
    )
      terminal = true
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
      const text = decoder.decode(bytes, { stream: true })
      // Track an unfinished SSE frame without retaining its content; CRLF can cross byte chunks.
      for (const char of text) {
        if (char === "\n" && carriage) {
          carriage = false
          continue
        }
        if (char === "\r" || char === "\n") {
          pending = line
          line = false
          carriage = char === "\r"
          continue
        }
        carriage = false
        line = true
      }
      parser.feed(text)
    },
    result() {
      if (problem || !reported) return { status: "unknown" as const, reason: problem ?? "no-terminal-usage" }
      return { status: "reported" as const, ...reported, basis: "provider-terminal-usage" as const }
    },
    // Final observation after reading ends. Cache decoder finalization so repeated reads stay conservative.
    models(end: "eof" | "incomplete" | "cancelled") {
      completeBytes ??= decoder.decode().length === 0
      return {
        status: end === "eof" && terminal && !line && !pending && completeBytes ? "complete" : "incomplete",
        labelStatus: invalidLabel
          ? "invalid"
          : labels.size > 1
            ? "conflicting"
            : labels.size === 1
              ? "consistent"
              : "unreported",
        labels: invalidLabel ? [] : [...labels],
        basis: "provider-response-label-only",
      }
    },
  }
}
