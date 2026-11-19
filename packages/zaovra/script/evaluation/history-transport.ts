import { Journal, type ModelDeclaration, type Usage, whole } from "./history-journal"
import { sha256 } from "./history-library"
import { HistoryPaused } from "./history-run"

export type ModelRequest = {
  route: string
  baseURL: string
  protocol: "responses" | "chat"
  model: string
  modelAliases?: ReadonlyArray<{ reported: string; evidence: string }>
  context?: string
  maxRequestBytes: number
  maxOutputTokens: number
  reserveTokens: number
  maxSends: number
  maxAttempts: number
  timeoutMs: number
}

export type TransportHost = {
  mode: "gravitex" | "loopback"
  credential: (route: string) => string | undefined
  signal?: AbortSignal
}

const isModelLabel = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[a-zA-Z0-9][a-zA-Z0-9_./-]{0,127}$/.test(value) &&
  !/^(?:sk-|www\.)/i.test(value) &&
  !/\.(?:com|net|org|io|dev|ai)(?:$|\/)/i.test(value)

export function resolveRequest(input: ModelRequest, mode: TransportHost["mode"]): ModelRequest {
  if (!URL.canParse(input.baseURL)) throw new Error("invalid-evaluation-model-request")
  const aliases = input.modelAliases ?? []
  if (
    !Array.isArray(aliases) ||
    aliases.length > 12 ||
    new Set(aliases.map(({ reported }) => reported)).size !== aliases.length ||
    aliases.some(
      ({ reported, evidence }) =>
        !isModelLabel(reported) ||
        reported === input.model ||
        typeof evidence !== "string" ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._:/#-]{0,159}$/.test(evidence),
    )
  )
    throw new Error("invalid-model-alias-policy")
  const endpoint = new URL(input.baseURL)
  const allowed =
    mode === "gravitex"
      ? endpoint.origin === "https://api.gravitex.ai"
      : mode === "loopback" && endpoint.protocol === "http:" && endpoint.hostname === "127.0.0.1" && !!endpoint.port
  if (
    !allowed ||
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname !== "/v1" ||
    endpoint.search ||
    endpoint.hash ||
    !["responses", "chat"].includes(input.protocol) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(input.route) ||
    !isModelLabel(input.model) ||
    (input.context !== undefined && (typeof input.context !== "string" || input.context.length > 12_000)) ||
    [
      input.maxRequestBytes,
      input.maxOutputTokens,
      input.reserveTokens,
      input.maxSends,
      input.maxAttempts,
      input.timeoutMs,
    ].some((limit) => !whole(limit) || limit === 0) ||
    input.maxAttempts > input.maxSends ||
    input.reserveTokens < input.maxOutputTokens ||
    input.timeoutMs > 300_000
  )
    throw new Error("invalid-evaluation-model-request")
  return {
    route: input.route,
    baseURL: endpoint.href,
    protocol: input.protocol,
    model: input.model,
    ...(aliases.length ? { modelAliases: aliases.map(({ reported, evidence }) => ({ reported, evidence })) } : {}),
    context: input.context ?? "",
    maxRequestBytes: input.maxRequestBytes,
    maxOutputTokens: input.maxOutputTokens,
    reserveTokens: input.reserveTokens,
    maxSends: input.maxSends,
    maxAttempts: input.maxAttempts,
    timeoutMs: input.timeoutMs,
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function verifyModel(policy: ModelRequest, raw: unknown, credential?: string): ModelDeclaration {
  const reported = record(raw)?.model
  if (reported == null) return { reportedModel: null, modelStatus: "missing", modelEvidence: null }
  if (!isModelLabel(reported) || (credential && reported.includes(credential)))
    return { reportedModel: null, modelStatus: "invalid", modelEvidence: null }
  if (reported === policy.model) return { reportedModel: reported, modelStatus: "exact", modelEvidence: null }
  const alias = policy.modelAliases?.find((item) => item.reported === reported)
  if (alias) return { reportedModel: reported, modelStatus: "alias", modelEvidence: alias.evidence }
  return { reportedModel: reported, modelStatus: "mismatch", modelEvidence: null }
}

function metering(value: unknown, chat: boolean): Usage | undefined {
  const raw = record(record(value)?.usage)
  if (!raw) return
  const hit = chat ? raw.prompt_cache_hit_tokens : undefined
  const miss = chat ? raw.prompt_cache_miss_tokens : undefined
  const input = chat ? (raw.prompt_tokens ?? (whole(hit) && whole(miss) ? hit + miss : undefined)) : raw.input_tokens
  const output = chat ? raw.completion_tokens : raw.output_tokens
  if (
    !whole(input) ||
    !whole(output) ||
    !whole(input + output) ||
    (raw.total_tokens != null && raw.total_tokens !== input + output)
  )
    return
  const inputDetails = chat ? raw.prompt_tokens_details : raw.input_tokens_details
  const outputDetails = chat ? raw.completion_tokens_details : raw.output_tokens_details
  if ((inputDetails != null && !record(inputDetails)) || (outputDetails != null && !record(outputDetails))) return
  const cached = record(inputDetails)?.cached_tokens
  const reasoning = record(outputDetails)?.reasoning_tokens
  if (
    [cached, hit, miss].some((n) => n != null && (!whole(n) || n > input)) ||
    (reasoning != null && (!whole(reasoning) || reasoning > output)) ||
    (hit != null && miss != null && Number(hit) + Number(miss) !== input) ||
    (hit != null && cached != null && hit !== cached)
  )
    return
  return {
    input,
    output,
    total: input + output,
    cachedInput: whole(cached) ? cached : whole(hit) ? hit : null,
    reasoning: whole(reasoning) ? reasoning : null,
  }
}

function answerText(value: unknown, chat: boolean) {
  const envelope = record(value)
  if (!envelope || envelope.error != null) return
  if (chat) {
    const choices = envelope.choices
    const choice = Array.isArray(choices) && choices.length === 1 ? record(choices[0]) : undefined
    const message = record(choice?.message)
    if (choice?.finish_reason !== "stop" || message?.role !== "assistant" || message.refusal != null) return
    return typeof message.content === "string" ? message.content : undefined
  }
  if (envelope.status !== "completed" || !Array.isArray(envelope.output)) return
  const messages = envelope.output.map(record).filter((item) => item?.type === "message")
  const message = messages.length === 1 ? messages[0] : undefined
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return
  const parts = message.content.map(record)
  if (parts.some((part) => part?.type !== "output_text" || typeof part.text !== "string")) return
  return parts.map((part) => part?.text).join("")
}

async function boundedJson(response: Response) {
  const reader = response.body?.getReader()
  if (!reader) return undefined
  const decoder = new TextDecoder("utf-8", { fatal: true })
  let bytes = 0
  let text = ""
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) return JSON.parse(text + decoder.decode()) as unknown
      bytes += chunk.value.length
      if (bytes > 1_048_576) return undefined
      text += decoder.decode(chunk.value, { stream: true })
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

export async function sendModel<A>(
  journal: Journal,
  host: TransportHost,
  policy: ModelRequest,
  request: { slot: string; step: number; system: string; data: unknown; signal?: AbortSignal },
  decode: (value: unknown) => A,
): Promise<{ value: A; tokens?: number }> {
  if (journal.totals().overrun) throw new HistoryPaused("reservation-overrun")
  const chat = policy.protocol === "chat"
  const target = policy.baseURL + (chat ? "/chat/completions" : "/responses")
  const messages = [
    { role: "system", content: request.system + (policy.context ? "\n\n" + policy.context : "") },
    { role: "user", content: JSON.stringify(request.data) },
  ]
  const body = JSON.stringify(
    chat
      ? { model: policy.model, messages, max_tokens: policy.maxOutputTokens, stream: false }
      : {
          model: policy.model,
          input: messages,
          max_output_tokens: policy.maxOutputTokens,
          store: false,
          stream: false,
        },
  )
  if (Buffer.byteLength(body) > policy.maxRequestBytes) throw new Error("evaluation-request-byte-limit")
  const aliases = policy.modelAliases?.length ? "\n" + JSON.stringify(policy.modelAliases) : ""
  const requestHash = sha256(target + "\n" + body + aliases)
  const done = journal.history(request.slot, request.step)
  if (done.some((send) => send.requestHash !== requestHash))
    throw new HistoryPaused("evaluation-request-changed-on-replay")
  const last = done.at(-1)
  if (last?.outcome === "ok" && last.value !== null) {
    const declaration = verifyModel(policy, { model: last.reportedModel })
    if (
      (declaration.modelStatus !== "exact" && declaration.modelStatus !== "alias") ||
      declaration.modelStatus !== last.modelStatus ||
      declaration.modelEvidence !== last.modelEvidence
    )
      throw new Error("recorded-model-unverified")
    const usage = last.usage ? (JSON.parse(last.usage) as Usage) : undefined
    return { value: decode(JSON.parse(last.value)), tokens: usage?.total }
  }
  if (last && last.outcome !== "retryable") throw new Error("recorded-" + last.outcome)
  for (let attempt = done.length + 1; attempt <= policy.maxAttempts; ++attempt) {
    if (host.signal?.aborted) throw new HistoryPaused("host-stopped")
    if (request.signal?.aborted) throw new Error("request-deadline")
    const credential = host.credential(policy.route)
    if (!credential || !/^[A-Za-z0-9._~+\/-]{8,1024}={0,2}$/.test(credential))
      throw new HistoryPaused("credential-unavailable")
    if ([body, aliases, policy.route].some((value) => value.includes(credential)))
      throw new Error("credential-in-model-request")
    const timeout = AbortSignal.timeout(policy.timeoutMs)
    const signal = AbortSignal.any([timeout, ...[request.signal].filter((item) => item !== undefined)])
    const physical = journal.start(
      {
        slot: request.slot,
        step: request.step,
        attempt,
        requestHash,
        model: policy.model,
        route: policy.route + "/" + policy.protocol,
        reserve: policy.reserveTokens,
      },
      policy.maxSends,
    )
    let response: Response
    try {
      response = await fetch(target, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + credential },
        body,
        signal,
        redirect: "error",
        keepalive: false,
      })
    } catch {
      journal.finish(physical, { outcome: "uncertain" })
      if (host.signal?.aborted) throw new HistoryPaused("host-stopped")
      throw new Error("send-outcome-uncertain")
    }
    const raw = await boundedJson(response).catch(() => undefined)
    const usage = metering(raw, chat)
    const declaration = verifyModel(policy, raw, credential)
    const status = response.status
    const overOutput = (usage?.output ?? 0) > policy.maxOutputTokens
    if (!response.ok) {
      const retryable = status === 429 || status >= 500
      journal.finish(physical, {
        outcome: retryable ? "retryable" : "rejected",
        status,
        usage,
        overOutput,
        declaration,
      })
      if (!retryable) throw new Error("upstream-rejected")
      if (attempt < policy.maxAttempts && !host.signal?.aborted) {
        // Every retry has its own durable reservation. Honor a bounded Retry-After.
        const delay = Number(response.headers.get("retry-after") ?? 0.3)
        await Bun.sleep(Math.min(10_000, Math.max(300, Number.isFinite(delay) ? delay * 1000 : 300)))
      }
      continue
    }
    if (declaration.modelStatus !== "exact" && declaration.modelStatus !== "alias") {
      journal.finish(physical, { outcome: "model-rejected", status, usage, overOutput, declaration })
      throw new Error("upstream-model-" + declaration.modelStatus)
    }
    const text = answerText(raw, chat)
    let value: A
    try {
      if (!text || text.includes(credential)) throw new Error("invalid-model-text")
      value = decode(JSON.parse(text))
      if (JSON.stringify(value).includes(credential)) throw new Error("invalid-model-text")
    } catch {
      journal.finish(physical, { outcome: "invalid-output", status, usage, overOutput, declaration })
      if (host.signal?.aborted) throw new HistoryPaused("host-stopped")
      throw new Error("invalid-model-output")
    }
    journal.finish(physical, { outcome: "ok", status, usage, value, overOutput, declaration })
    return { value, tokens: usage?.total }
  }
  throw new Error("retry-limit")
}
