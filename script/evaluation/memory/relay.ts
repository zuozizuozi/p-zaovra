import { appendFileSync, closeSync, openSync } from "node:fs"
import { createHash, randomUUID } from "node:crypto"
import path from "node:path"
import { Option, Schema } from "effect"
import { OpenAIChat } from "../../../packages/llm/src/protocols/openai-chat"
import { OpenAIResponses } from "../../../packages/llm/src/protocols/openai-responses"
import { observeUsage } from "./usage"
import { createStageUsage, StageUsageHeader } from "./stage-usage"
import { SessionHostState } from "../../../packages/schema/src/session-host-state"

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

const usageOwners = new WeakMap<object, () => ReturnType<typeof createStageUsage> & Disposable>()

export function startEvaluationStageUsage(
  relay: object,
  expected: { baseURL: string; apiKey: string; model: string; protocol: string },
) {
  const binding = evaluationRelayBinding(relay)
  if (
    binding.baseURL !== expected.baseURL ||
    binding.apiKey !== expected.apiKey ||
    binding.model !== expected.model ||
    binding.protocol !== expected.protocol
  )
    throw new Error("evaluation-stage-usage-relay-mismatch")
  return usageOwners.get(relay)!()
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
  /** B3 wire template evidence only; never authenticates host provenance. */
  b3HostHints?: boolean
}) {
  // Keep transport ownership fixed even if the caller later edits its option object.
  const input = { ...options }
  const endpoint = new URL(input.baseURL)
  if (
    (input.b3HostHints !== undefined && typeof input.b3HostHints !== "boolean") ||
    !path.isAbsolute(input.journal) ||
    !input.apiKey ||
    !input.model ||
    !["openai-chat", "openai-responses"].includes(input.protocol) ||
    ![input.maxRequests, input.maxRequestBytes, input.maxOutput].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    ) ||
    input.maxRequests > 60 ||
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
  const pendingLabels = new Map<AbortController, () => void>()
  let sent = 0
  let closed = false
  let stageUsage: ReturnType<typeof createStageUsage> | undefined
  let stageUsageEnabled = false
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
        const stage = stageUsage?.match(request.headers.get(StageUsageHeader))
        const binding = stage?.binding
        if (stageUsageEnabled && !binding) return deny(403, "evaluation-stage-binding")
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
        if (stageUsageEnabled && (!stage || stageUsage?.match(stage.key) !== stage))
          return deny(403, "evaluation-stage-binding")
        const id = randomUUID()
        log({
          id,
          phase: "admitted",
          ordinal: sent + 1,
          ...binding,
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          output,
          usage: "unknown",
        })
        if (input.b3HostHints)
          log({
            id,
            phase: "b3-host-hints",
            ordinal: sent + 1,
            bodySHA256: createHash("sha256").update(bytes).digest("hex"),
            evidence: "template-match",
            origin: "unverified",
            matches: b3Hints(body, input.protocol),
          })
        sent++
        const controller = new AbortController()
        const deadline = AbortSignal.timeout(120000)
        const started = performance.now()
        active.add(controller)
        const usage = observeUsage(input.protocol, [
          input.apiKey,
          key,
          input.baseURL,
          endpoint.hostname,
          stage?.key ?? "",
        ])
        let labelsRecorded = false
        const recordModels = (end: "eof" | "incomplete" | "cancelled") => {
          if (closed || labelsRecorded) return
          labelsRecorded = true
          pendingLabels.delete(controller)
          log({ id, phase: "response-model-observed", end, ...usage.models(end) })
          log({ id, phase: "response-termination-observed", end, ...usage.termination() })
        }
        pendingLabels.set(controller, () => recordModels("cancelled"))
        let usageRecorded = false
        const settle = stage?.track(id, sent, () => {
          recordUsage("cancelled")
          controller.abort()
        })
        function recordUsage(end: "eof" | "incomplete" | "cancelled") {
          if (closed || usageRecorded) return
          usageRecorded = true
          const observation = usage.result()
          log({ id, phase: "usage-observed", end, ...observation })
          settle?.(observation)
          recordModels(end)
        }
        try {
          const response = await fetch(target, {
            method: "POST",
            body: bytes,
            redirect: "error",
            headers: { "content-type": "application/json", authorization: `Bearer ${input.apiKey}` },
            signal: AbortSignal.any([request.signal, controller.signal, deadline]),
          })
          if (!closed) log({ id, phase: "headers", status: response.status })
          const reader = response.body?.getReader()
          if (!reader) {
            if (stage) recordUsage("eof")
            recordModels("eof")
            active.delete(controller)
            return new Response(null, { status: response.status })
          }
          let received = 0
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
                } catch (error) {
                  recordUsage("incomplete")
                  if (!closed)
                    log({
                      id,
                      phase: "incomplete",
                      usage: "unknown",
                      error: transportFailure(error),
                      elapsedMs: Math.round(performance.now() - started),
                      cancellation: {
                        request: request.signal.aborted,
                        relay: controller.signal.aborted,
                        deadline: deadline.aborted,
                      },
                    })
                  controller.abort()
                  active.delete(controller)
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
        } catch (error) {
          if (stage) recordUsage("incomplete")
          recordModels("incomplete")
          if (!closed)
            log({
              id,
              phase: "transport-failed",
              usage: "unknown",
              generatedStatus: 502,
              error: transportFailure(error),
              elapsedMs: Math.round(performance.now() - started),
              cancellation: {
                request: request.signal.aborted,
                relay: controller.signal.aborted,
                deadline: deadline.aborted,
              },
            })
          controller.abort()
          active.delete(controller)
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
        try {
          stageUsage?.close()
          for (const record of pendingLabels.values()) record()
        } finally {
          closed = true
          for (const controller of active) controller.abort()
          try {
            await server.stop(true)
          } finally {
            closeSync(file)
          }
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
  usageOwners.set(handle, () => {
    if (closed || stageUsage || (sent && !stageUsageEnabled))
      throw new Error("evaluation-stage-usage-relay-already-used")
    const usage = createStageUsage(log)
    log({ phase: "stage-usage-enabled", runID: usage.runID, version: 1 })
    stageUsage = usage
    stageUsageEnabled = true
    return {
      ...usage,
      [Symbol.dispose]() {
        if (stageUsage !== usage) return
        try {
          usage.close()
        } finally {
          stageUsage = undefined
        }
      },
    }
  })
  return handle
}

function transportFailure(error: unknown) {
  // Never serialize arbitrary error text, URLs, stacks or properties from a failed credentialed fetch.
  const codes = new Set([
    "ECONNREFUSED",
    "ECONNRESET",
    "ECONNABORTED",
    "ENOTFOUND",
    "EAI_AGAIN",
    "ETIMEDOUT",
    "ConnectionRefused",
    "ConnectionClosed",
    "SocketError",
    "ERR_TLS_CERT_ALTNAME_INVALID",
    "CERT_HAS_EXPIRED",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  ])
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined
  const cause = error && typeof error === "object" && "cause" in error ? error.cause : undefined
  const causeCode = cause && typeof cause === "object" && "code" in cause ? cause.code : undefined
  return {
    name:
      error instanceof Error && ["Error", "TypeError", "AbortError", "TimeoutError"].includes(error.name)
        ? error.name
        : "other",
    code: typeof code === "string" && codes.has(code) ? code : null,
    causeCode: typeof causeCode === "string" && codes.has(causeCode) ? causeCode : null,
  }
}

function localText(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(localText)
  if (!value || typeof value !== "object") return true
  const object = value as Record<string, unknown>
  if (["input_image", "image_url", "item_reference"].includes(String(object.type))) return false
  return Object.values(object).every(localText)
}

// Fixed B3 vocabulary, deliberately independent of ambient experiment environment.
// Drift produces an empty match, never a guessed variant or user-text dump.
const b3Facts = [
  {
    kind: "execution",
    style: "original",
    language: "en",
    text: "executableRemainingMs ends provider/tool admission before the host cleanup reserve. remainingMs includes that reserve; finish necessary checks and report actual job states before executionDeadline. Never restart running or unknown jobs.",
  },
  {
    kind: "execution",
    style: "short",
    language: "en",
    text: "executableRemainingMs stops provider/tool admission before cleanup reserve; remainingMs includes reserve. Finish required checks and report actual job states before executionDeadline. Never restart running/unknown jobs.",
  },
  {
    kind: "execution",
    style: "original",
    language: "zh",
    text: "executableRemainingMs在宿主清理预留时间之前结束provider/工具准入；remainingMs包含该预留时间。请在executionDeadline前完成必要检查并报告实际任务状态，绝不重新启动运行中或状态未知的任务。",
  },
  {
    kind: "execution",
    style: "short",
    language: "zh",
    text: "executableRemainingMs截止即停止provider/工具准入，早于清理预留段；remainingMs含预留段。executionDeadline前完成必需检查并如实报任务状态；不重启运行中/未知任务。",
  },
  {
    kind: "advisory",
    style: "original",
    language: "en",
    text: "The advisory deadline is a planning reminder, not a stop condition. remainingMs, when present, is the enforced wall-clock budget.",
  },
  {
    kind: "advisory",
    style: "short",
    language: "en",
    text: "Advisory deadline: planning only, not a stop. remainingMs, if present, is the enforced wall-clock budget.",
  },
  {
    kind: "advisory",
    style: "original",
    language: "zh",
    text: "建议截止时间仅用于规划提醒，不是停止条件。若有remainingMs，它表示强制执行的墙钟预算。",
  },
  {
    kind: "advisory",
    style: "short",
    language: "zh",
    text: "建议截止仅供规划，不触发停止；remainingMs（若有）是强制墙钟预算。",
  },
  {
    kind: "gap",
    style: "original",
    language: "en",
    text: "Preserve the current runnable artifact and address the smallest acceptance gap first. Do not omit requirements or necessary validation.",
  },
  {
    kind: "gap",
    style: "short",
    language: "en",
    text: "Keep the runnable artifact; fix the smallest acceptance gap first. Omit no requirements or necessary validation.",
  },
  {
    kind: "gap",
    style: "original",
    language: "zh",
    text: "保留当前可运行产物，优先处理最小验收缺口；不得省略要求或必要验证。",
  },
  { kind: "gap", style: "short", language: "zh", text: "保留可运行产物，先补最小验收缺口；不省要求或必要验证。" },
] as const

function b3Hints(body: Record<string, unknown>, protocol: "openai-chat" | "openai-responses") {
  const messages = protocol === "openai-chat" ? body.messages : body.input
  if (!Array.isArray(messages)) return []
  return messages.flatMap((message: unknown, messageIndex) => {
    if (
      !message ||
      typeof message !== "object" ||
      !("role" in message) ||
      message.role !== "user" ||
      !("content" in message)
    )
      return []
    if (protocol === "openai-responses" && (!("type" in message) || message.type !== "message")) return []
    const content =
      typeof message.content === "string" ? [message.content] : Array.isArray(message.content) ? message.content : []
    return content.flatMap((part: unknown, partIndex) => {
      const text =
        typeof part === "string"
          ? part
          : part &&
              typeof part === "object" &&
              "type" in part &&
              part.type === (protocol === "openai-chat" ? "text" : "input_text") &&
              "text" in part &&
              typeof part.text === "string"
            ? part.text
            : undefined
      if (text === undefined) return []
      // Both actual lowerers send chronological updates as user text. Even exact
      // wrappers can be user-forged: these records never authenticate a host.
      const matches: Array<{
        kind: string
        style?: string
        language?: string
        scale?: string
        offset: number
        bytes: number
        sha256: string
        containerSHA256?: string
        containerBytes?: number
      }> = []
      const checkpoint =
        /^(Wall-clock delivery checkpoint: ([0-9]+(?:\.[0-9]+)?)ms remain\. Save a version that meets basic requested acceptance before improving it\.( Choose training or build scale from the remaining time, preserve necessary validation, and do not label a partial artifact complete\.)?)(?=\n<system-update>\n|$)/.exec(
          text,
        )
      if (checkpoint && Number.isFinite(Number(checkpoint[2])) && Number(checkpoint[2]) > 0)
        matches.push({
          kind: "budget-checkpoint",
          scale: checkpoint[3] ? "on" : "off",
          offset: 0,
          bytes: Buffer.byteLength(checkpoint[1]),
          sha256: createHash("sha256").update(checkpoint[1]).digest("hex"),
        })
      for (const wrapper of text.matchAll(
        /(?:^|\n)(<system-update>\n(Current task facts \(host observations, not new requirements\): [^\n]+)\n([^<]*?)\n<\/system-update>)(?=\n<system-update>\n|$)/g,
      )) {
        const json = wrapper[2]
          .slice("Current task facts (host observations, not new requirements): ".length)
          .replaceAll("&lt;", "<")
          .replaceAll("&gt;", ">")
          .replaceAll("&amp;", "&")
        if (
          Option.isNone(
            Schema.decodeUnknownOption(Schema.UnknownFromJsonString.pipe(Schema.decodeTo(SessionHostState.Facts)), {
              onExcessProperty: "error",
            })(json),
          )
        )
          continue
        const hints = wrapper[3].split("\n").map((line) => b3Facts.find((hint) => hint.text === line))
        if (!hints.length || hints.some((hint) => hint === undefined)) continue
        for (const hint of hints) {
          if (!hint) continue
          matches.push({
            kind: hint.kind,
            style: hint.style,
            language: hint.language,
            offset: wrapper.index + wrapper[0].indexOf(wrapper[1]),
            bytes: Buffer.byteLength(hint.text),
            sha256: createHash("sha256").update(hint.text).digest("hex"),
            containerSHA256: createHash("sha256").update(wrapper[1]).digest("hex"),
            containerBytes: Buffer.byteLength(wrapper[1]),
          })
        }
      }
      return matches.map((match) => ({ ...match, role: "user", messageIndex, partIndex }))
    })
  })
}
