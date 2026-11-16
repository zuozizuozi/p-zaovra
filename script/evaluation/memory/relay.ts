import { appendFileSync, closeSync, openSync } from "node:fs"
import { createHash, randomUUID } from "node:crypto"
import path from "node:path"
import { Option, Schema } from "effect"
import { OpenAIChat } from "../../../packages/llm/src/protocols/openai-chat"
import { OpenAIResponses } from "../../../packages/llm/src/protocols/openai-responses"
import { observeUsage } from "./usage"

const owned = new WeakMap<
  object,
  () => { baseURL: string; apiKey: string; model: string; protocol: string; endpointHash: string }
>()

/** Only a live handle returned here can establish a C host's transport ownership. */
export function evaluationRelayBinding(relay: object) {
  const read = owned.get(relay)
  if (!read) throw new Error("evaluation-relay-not-owned")
  return read()
}

/** Evaluation-only physical send guard, NOT a token counter or a settlement engine.
 * One host owns it across all Sessions in a chain. Unknown token reservations remain in the outer ledger.
 * The product receives only the ephemeral local key; the real credential never enters its tools' environment.
 */
export function startEvaluationRelay(options: {
  baseURL: string
  apiKey: string
  model: string
  protocol: "openai-chat" | "openai-responses"
  journal: string
  maxRequests: number
  maxRequestBytes: number
  maxOutput: number
}) {
  // Keep transport ownership fixed even if the caller later edits its option object.
  const input = { ...options }
  const endpoint = new URL(input.baseURL)
  if (
    !path.isAbsolute(input.journal) ||
    !input.apiKey ||
    !input.model ||
    !["openai-chat", "openai-responses"].includes(input.protocol) ||
    ![input.maxRequests, input.maxRequestBytes, input.maxOutput].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    ) ||
    input.maxRequests > 40 ||
    input.maxRequestBytes > 131072 ||
    input.maxOutput > 4096 ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    !(endpoint.protocol === "https:" || (endpoint.protocol === "http:" && endpoint.hostname === "127.0.0.1"))
  )
    throw new Error("invalid-evaluation-relay")
  const route = input.protocol === "openai-responses" ? OpenAIResponses.route : OpenAIChat.route
  const suffix = input.protocol === "openai-responses" ? "/responses" : "/chat/completions"
  const target = input.baseURL.replace(/\/+$/, "") + suffix
  const key = randomUUID()
  const file = openSync(input.journal, "wx")
  const active = new Set<AbortController>()
  let sent = 0
  let closed = false
  const log = (record: object) => appendFileSync(file, JSON.stringify(record) + "\n")
  const deny = (status: number, reason: string) => {
    if (!closed) log({ phase: "denied", reason })
    return new Response(null, { status })
  }
  const manifest = {
    phase: "manifest",
    model: input.model,
    protocol: input.protocol,
    endpointHash: createHash("sha256").update(target).digest("hex"),
    maxRequests: input.maxRequests,
    maxRequestBytes: input.maxRequestBytes,
    maxOutput: input.maxOutput,
    tokenLimit: "not-proven",
  }
  const createServer = () =>
    Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 0,
      maxRequestBodySize: input.maxRequestBytes,
      async fetch(request) {
        const url = new URL(request.url)
        if (
          request.method !== "POST" ||
          url.pathname !== "/v1" + suffix ||
          url.search ||
          request.headers.get("authorization") !== `Bearer ${key}`
        )
          return deny(403, "local-route-or-authorization")
        const wire = await (async () => {
          try {
            const bytes = new Uint8Array(await request.arrayBuffer())
            return {
              bytes,
              parsed: Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(
                new TextDecoder("utf-8", { fatal: true }).decode(bytes),
              ),
            }
          } catch {
            return undefined
          }
        })()
        if (!wire) return deny(400, "invalid-request-body")
        const bytes = wire.bytes
        if (bytes.length > input.maxRequestBytes) return deny(413, "request-bytes")
        const parsed = wire.parsed
        if (Option.isNone(parsed) || !parsed.value || typeof parsed.value !== "object") return deny(400, "invalid-json")
        const body = parsed.value as Record<string, unknown>
        if (
          body.model !== input.model ||
          body.stream !== true ||
          Option.isNone(Schema.decodeUnknownOption(route.body.schema, { onExcessProperty: "error" })(body))
        )
          return deny(400, "wire-model-stream-or-schema")
        if (!localText(body.input ?? body.messages)) return deny(400, "external-input")
        const limits = ["max_tokens", "max_completion_tokens", "max_output_tokens"].filter(
          (name) => body[name] !== undefined,
        )
        const allowed =
          input.protocol === "openai-responses" ? ["max_output_tokens"] : ["max_tokens", "max_completion_tokens"]
        const output = body[limits[0]]
        if (
          limits.length !== 1 ||
          !allowed.includes(limits[0]) ||
          typeof output !== "number" ||
          !Number.isSafeInteger(output) ||
          output <= 0 ||
          output > input.maxOutput
        )
          return deny(400, "wire-output-limit")
        // No await between the limit check and synchronous recording: concurrent local callers cannot oversubscribe.
        if (closed || sent >= input.maxRequests) return deny(429, "physical-request-limit")
        const id = randomUUID()
        log({
          id,
          phase: "admitted",
          ordinal: sent + 1,
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          output,
          usage: "unknown",
        })
        sent++
        const controller = new AbortController()
        active.add(controller)
        try {
          const response = await fetch(target, {
            method: "POST",
            body: bytes,
            redirect: "error",
            headers: { "content-type": "application/json", authorization: `Bearer ${input.apiKey}` },
            signal: AbortSignal.any([request.signal, controller.signal, AbortSignal.timeout(120000)]),
          })
          if (!closed) log({ id, phase: "headers", status: response.status })
          const reader = response.body?.getReader()
          if (!reader) {
            active.delete(controller)
            return new Response(null, { status: response.status })
          }
          let received = 0
          const usage = observeUsage(input.protocol)
          let usageRecorded = false
          const recordUsage = (end: "eof" | "incomplete" | "cancelled") => {
            if (closed || usageRecorded) return
            usageRecorded = true
            log({ id, phase: "usage-observed", end, ...usage.result() })
          }
          return new Response(
            new ReadableStream<Uint8Array>({
              async pull(stream) {
                try {
                  const chunk = await reader.read()
                  if (chunk.done) {
                    recordUsage("eof")
                    if (!closed) log({ id, phase: "eof", bytes: received, usage: "unknown" })
                    active.delete(controller)
                    stream.close()
                    return
                  }
                  received += chunk.value.length
                  if (received > 4194304) throw new Error("response-limit")
                  usage.feed(chunk.value)
                  stream.enqueue(chunk.value)
                } catch {
                  recordUsage("incomplete")
                  controller.abort()
                  active.delete(controller)
                  if (!closed) log({ id, phase: "incomplete", usage: "unknown" })
                  stream.error(new Error("evaluation-relay-stream-incomplete"))
                }
              },
              async cancel() {
                recordUsage("cancelled")
                controller.abort()
                await reader.cancel().catch(() => {})
                active.delete(controller)
              },
            }),
            {
              status: response.status,
              headers: { "content-type": response.headers.get("content-type") ?? "application/octet-stream" },
            },
          )
        } catch {
          controller.abort()
          active.delete(controller)
          if (!closed) log({ id, phase: "transport-failed", usage: "unknown" })
          return new Response(null, { status: 502 })
        }
      },
    })
  const server = (() => {
    try {
      log(manifest)
      return createServer()
    } catch {
      closeSync(file)
      throw new Error("evaluation-relay-start-failed")
    }
  })()
  let stopping: Promise<void> | undefined
  const baseURL = `http://127.0.0.1:${server.port}/v1`
  const handle = {
    baseURL,
    apiKey: key,
    stop() {
      return (stopping ??= (async () => {
        closed = true
        for (const controller of active) controller.abort()
        try {
          await server.stop(true)
        } finally {
          closeSync(file)
        }
      })())
    },
  }
  owned.set(handle, () => {
    if (closed) throw new Error("evaluation-relay-closed")
    return {
      baseURL,
      apiKey: key,
      model: input.model,
      protocol: input.protocol,
      endpointHash: manifest.endpointHash,
    }
  })
  return handle
}

function localText(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(localText)
  if (!value || typeof value !== "object") return true
  const object = value as Record<string, unknown>
  if (["input_image", "image_url", "item_reference"].includes(String(object.type))) return false
  return Object.values(object).every(localText)
}
