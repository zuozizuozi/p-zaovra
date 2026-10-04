import { Cause, Context, Effect, Layer, Option, Random, Schema, Stream } from "effect"
import {
  FetchHttpClient,
  Headers,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http"
import {
  AuthenticationReason,
  ContentPolicyReason,
  HttpContext,
  HttpRateLimitDetails,
  HttpRequestDetails,
  HttpResponseDetails,
  InvalidRequestReason,
  LLMError,
  type LLMEvent,
  ProviderInternalReason,
  QuotaExceededReason,
  RateLimitReason,
  TransportReason,
  UnknownProviderReason,
} from "../schema"
import { isContextOverflow } from "../provider-error"

export interface Interface {
  readonly execute: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, LLMError>
}

export class Service extends Context.Service<Service, Interface>()("@zaovra/LLM/RequestExecutor") {}

export const RetryObserver = Context.Reference<
  (input: { attempt: number; delayMs: number; error: LLMError }) => Effect.Effect<void>
>("@zaovra/LLM/RetryObserver", { defaultValue: () => () => Effect.void })

const BODY_LIMIT = 16_384
const MAX_RETRIES = 5
const REQUEST_TIMEOUT = "120 seconds"
const BASE_DELAY_MS = 2_000
const MAX_DELAY_MS = 30_000
const REDACTED = "<redacted>"

// One source of truth for what counts as a sensitive name across headers,
// URL query keys, and field names embedded inside request/response bodies.
//
// `SENSITIVE_NAME` is used as both a substring matcher (for free-form header
// names like `Authorization` / `X-API-Key`) and as the body-field alternation
// list. `SHORT_QUERY_NAME` covers anchored short keys like `?key=…` / `?sig=…`
// that are too generic to redact substring-style without false positives.
const SENSITIVE_NAME_SOURCE =
  "authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|token|secret|credential|signature|x-amz-signature"
const SENSITIVE_NAME = new RegExp(SENSITIVE_NAME_SOURCE, "i")
const SHORT_QUERY_NAME = /^(key|sig)$/i
const SENSITIVE_BODY_FIELD = new RegExp(`(?:${SENSITIVE_NAME_SOURCE}|key)`, "i")
const REDACT_JSON_FIELD = new RegExp(`("(?:${SENSITIVE_BODY_FIELD.source})"\\s*:\\s*)"[^"]*"`, "gi")
const REDACT_QUERY_FIELD = new RegExp(`((?:${SENSITIVE_BODY_FIELD.source})=)[^&\\s"]+`, "gi")

const isSensitiveHeaderName = (name: string) => SENSITIVE_NAME.test(name)

const isSensitiveQueryName = (name: string) => isSensitiveHeaderName(name) || SHORT_QUERY_NAME.test(name)

const redactHeaders = (headers: Headers.Headers, redactedNames: ReadonlyArray<string | RegExp>) =>
  Object.fromEntries(
    Object.entries(Headers.redact(headers, [...redactedNames, SENSITIVE_NAME])).map(([name, value]) => [
      name,
      String(value),
    ]),
  )

const redactUrl = (value: string) => {
  if (!URL.canParse(value)) return REDACTED
  const url = new URL(value)
  url.searchParams.forEach((_, key) => {
    if (isSensitiveQueryName(key)) url.searchParams.set(key, REDACTED)
  })
  return url.toString()
}

const normalizedHeaders = (headers: Headers.Headers) =>
  Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]))

const requestId = (headers: Record<string, string>) => {
  return (
    headers["x-generation-id"] ??
    headers["x-request-id"] ??
    headers["request-id"] ??
    headers["x-amzn-requestid"] ??
    headers["x-amz-request-id"] ??
    headers["x-goog-request-id"] ??
    headers["cf-ray"]
  )
}

const retryableStatus = (status: number) => status === 429 || status === 503 || status === 504 || status === 529

const retryAfterMs = (headers: Record<string, string>) => {
  const millis = Number(headers["retry-after-ms"])
  if (Number.isFinite(millis)) return Math.max(0, millis)

  const value = headers["retry-after"]
  if (!value) return undefined

  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)

  const date = Date.parse(value)
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now())
  return undefined
}

const addRateLimitValue = (target: Record<string, string>, key: string, value: string) => {
  if (key.length > 0) target[key] = value
}

const rateLimitDetails = (headers: Record<string, string>, retryAfter: number | undefined) => {
  const limit: Record<string, string> = {}
  const remaining: Record<string, string> = {}
  const reset: Record<string, string> = {}

  Object.entries(headers).forEach(([name, value]) => {
    const openaiLimit = /^x-ratelimit-limit-(.+)$/.exec(name)?.[1]
    if (openaiLimit) return addRateLimitValue(limit, openaiLimit, value)

    const openaiRemaining = /^x-ratelimit-remaining-(.+)$/.exec(name)?.[1]
    if (openaiRemaining) return addRateLimitValue(remaining, openaiRemaining, value)

    const openaiReset = /^x-ratelimit-reset-(.+)$/.exec(name)?.[1]
    if (openaiReset) return addRateLimitValue(reset, openaiReset, value)

    const anthropic = /^anthropic-ratelimit-(.+)-(limit|remaining|reset)$/.exec(name)
    if (!anthropic) return
    if (anthropic[2] === "limit") return addRateLimitValue(limit, anthropic[1], value)
    if (anthropic[2] === "remaining") return addRateLimitValue(remaining, anthropic[1], value)
    return addRateLimitValue(reset, anthropic[1], value)
  })

  if (
    retryAfter === undefined &&
    Object.keys(limit).length === 0 &&
    Object.keys(remaining).length === 0 &&
    Object.keys(reset).length === 0
  )
    return undefined

  return new HttpRateLimitDetails({
    retryAfterMs: retryAfter,
    limit: Object.keys(limit).length === 0 ? undefined : limit,
    remaining: Object.keys(remaining).length === 0 ? undefined : remaining,
    reset: Object.keys(reset).length === 0 ? undefined : reset,
  })
}

const requestDetails = (request: HttpClientRequest.HttpClientRequest, redactedNames: ReadonlyArray<string | RegExp>) =>
  new HttpRequestDetails({
    method: request.method,
    url: redactUrl(request.url),
    headers: redactHeaders(request.headers, redactedNames),
  })

const responseDetails = (
  response: HttpClientResponse.HttpClientResponse,
  redactedNames: ReadonlyArray<string | RegExp>,
) =>
  new HttpResponseDetails({
    status: response.status,
    headers: redactHeaders(response.headers, redactedNames),
  })

const secretValues = (request: HttpClientRequest.HttpClientRequest) => {
  const values = new Set<string>()
  const add = (value: string) => {
    if (value.length < 4) return
    values.add(value)
    values.add(encodeURIComponent(value))
  }

  Object.entries(request.headers).forEach(([name, value]) => {
    if (!isSensitiveHeaderName(name)) return
    add(value)
    const bearer = /^Bearer\s+(.+)$/i.exec(value)?.[1]
    if (bearer) add(bearer)
  })

  if (!URL.canParse(request.url)) return values
  new URL(request.url).searchParams.forEach((value, key) => {
    if (isSensitiveQueryName(key)) add(value)
  })
  return values
}

// Two passes: structural (redact `"name": "value"` and `name=value` patterns
// for any field name that looks sensitive) plus literal (replace any actual
// secret values we sent in the request, in case the response echoes one back).
const redactBody = (body: string, request: HttpClientRequest.HttpClientRequest) =>
  Array.from(secretValues(request)).reduce(
    (text, secret) => text.split(secret).join(REDACTED),
    body.replace(REDACT_JSON_FIELD, `$1"${REDACTED}"`).replace(REDACT_QUERY_FIELD, `$1${REDACTED}`),
  )

const responseBody = (body: string | void, request: HttpClientRequest.HttpClientRequest) => {
  if (body === undefined) return {}
  const redacted = redactBody(body, request)
  if (redacted.length <= BODY_LIMIT) return { body: redacted }
  return { body: redacted.slice(0, BODY_LIMIT), bodyTruncated: true }
}

const providerMessage = (status: number, body: string | void, request: HttpClientRequest.HttpClientRequest) => {
  const parsed = body
    ? Option.getOrUndefined(Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(body))
    : undefined
  const record = (value: unknown): Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  const root = record(parsed)
  const error = record(root.error)
  // Extract before the diagnostic body is truncated, then redact decoded strings
  // before limiting them so an escaped/partially clipped credential cannot leak.
  const detail = [
    ...new Set(
      [error.message, root.message, error.remedy_hint, root.remedy_hint]
        .filter((value): value is string => typeof value === "string" && !!value.trim())
        .map((value) => redactBody(value, request).trim().slice(0, 240)),
    ),
  ]
    .join("; ")
    .slice(0, 960)
  const message = detail || (body && body.length <= 500 ? redactBody(body, request) : "")
  const chat = URL.canParse(request.url) && new URL(request.url).pathname.endsWith("/chat/completions")
  const responses = URL.canParse(request.url) && new URL(request.url).pathname.endsWith("/responses")
  const responsesUnavailable =
    [400, 500, 501].includes(status) &&
    responses &&
    (error.code === "convert_request_failed" || error.type === "convert_request_failed") &&
    /\bnot implemented\b/i.test(message)
  const responsesRequired =
    /\b(?:use|requires?|switch to)\s+(?:the\s+)?(?:\/(?:[\w-]+\/)*responses\b|responses\s+(?:api|endpoint|protocol)\b)/i.test(
      message,
    ) &&
    !/\b(?:not|never|don't|cannot|can't)\s+(?:use|requires?|switch to)\s+(?:the\s+)?(?:\/(?:[\w-]+\/)*responses|responses)/i.test(
      message,
    )
  const incompatible =
    /\b(?:function\s+)?tools?\s+with\s+reasoning(?:_effort)?\s+(?:are|is)\s+not\s+supported\b/i.test(message) ||
    responsesRequired
  const context = /context.{0,40}(?:length|limit|exceed|window)|(?:too many|maximum).{0,20}tokens/i.test(message)
  const hint =
    status === 400 && chat && incompatible && !context
      ? " If this model supports Responses, select Responses in Settings > Providers > Protocol settings, then continue."
      : responsesUnavailable && !context
        ? " This model may require Chat Completions. Select Chat Completions in Settings > Providers > Protocol settings, then continue."
        : ""
  if (message) return `Provider request failed with HTTP ${status}: ${message}${hint}`
  return `Provider request failed with HTTP ${status}`
}

const responseHttp = (input: {
  readonly request: HttpClientRequest.HttpClientRequest
  readonly response: HttpClientResponse.HttpClientResponse
  readonly redactedNames: ReadonlyArray<string | RegExp>
  readonly body: ReturnType<typeof responseBody>
  readonly requestId?: string | undefined
  readonly rateLimit?: HttpRateLimitDetails | undefined
}) =>
  new HttpContext({
    request: requestDetails(input.request, input.redactedNames),
    response: responseDetails(input.response, input.redactedNames),
    ...input.body,
    requestId: input.requestId,
    rateLimit: input.rateLimit,
  })

const statusReason = (input: {
  readonly status: number
  readonly message: string
  readonly retryAfterMs?: number | undefined
  readonly rateLimit?: HttpRateLimitDetails | undefined
  readonly http: HttpContext
}) => {
  const body = input.http.body ?? ""
  if (/content[-_\s]?policy|content_filter|safety/i.test(body)) {
    return new ContentPolicyReason({ message: input.message, http: input.http })
  }
  if (input.status === 401) {
    return new AuthenticationReason({ message: input.message, kind: "invalid", http: input.http })
  }
  if (input.status === 403) {
    return new AuthenticationReason({ message: input.message, kind: "insufficient-permissions", http: input.http })
  }
  if (input.status === 429) {
    if (/insufficient[-_\s]?quota|quota[-_\s]?exceeded|free-models-per-day|openrouter_free_tier_daily/i.test(body)) {
      return new QuotaExceededReason({ message: input.message, http: input.http })
    }
    return new RateLimitReason({
      message: input.message,
      retryAfterMs: input.retryAfterMs,
      rateLimit: input.rateLimit,
      http: input.http,
    })
  }
  if (
    input.status === 400 ||
    input.status === 404 ||
    input.status === 409 ||
    input.status === 413 ||
    input.status === 422
  ) {
    return new InvalidRequestReason({
      message: input.message,
      classification: isContextOverflow(body) ? "context-overflow" : undefined,
      http: input.http,
    })
  }
  if (input.status >= 500 || retryableStatus(input.status)) {
    return new ProviderInternalReason({
      message: input.message,
      status: input.status,
      retryAfterMs: input.retryAfterMs,
      http: input.http,
    })
  }
  return new UnknownProviderReason({ message: input.message, status: input.status, http: input.http })
}

const statusError =
  (request: HttpClientRequest.HttpClientRequest, redactedNames: ReadonlyArray<string | RegExp>) =>
  (response: HttpClientResponse.HttpClientResponse) =>
    Effect.gen(function* () {
      if (response.status < 400) return response
      const body = yield* response.text.pipe(
        Effect.timeout("10 seconds"),
        Effect.catch(() => Effect.void),
      )
      const headers = normalizedHeaders(response.headers)
      const retryAfter = retryAfterMs(headers)
      const rateLimit = rateLimitDetails(headers, retryAfter)
      const details = responseBody(body, request)
      return yield* new LLMError({
        module: "RequestExecutor",
        method: "execute",
        reason: statusReason({
          status: response.status,
          message: providerMessage(response.status, body, request),
          retryAfterMs: retryAfter,
          rateLimit,
          http: responseHttp({
            request,
            response,
            redactedNames,
            body: details,
            requestId: requestId(headers),
            rateLimit,
          }),
        }),
      })
    })

const toHttpError = (redactedNames: ReadonlyArray<string | RegExp>) => (error: unknown) => {
  const transportError = (input: {
    readonly message: string
    readonly kind?: string | undefined
    readonly request?: HttpClientRequest.HttpClientRequest | undefined
  }) =>
    new LLMError({
      module: "RequestExecutor",
      method: "execute",
      reason: new TransportReason({
        message: input.message,
        kind: input.kind,
        diagnostics: TransportReason.diagnostics(error, "request"),
        url: input.request ? redactUrl(input.request.url) : undefined,
        http: input.request ? new HttpContext({ request: requestDetails(input.request, redactedNames) }) : undefined,
      }),
    })

  if (Cause.isTimeoutError(error)) {
    return transportError({ message: "模型请求建立超时：单次等待 120 秒仍未收到响应头。", kind: "Timeout" })
  }
  if (!HttpClientError.isHttpClientError(error)) {
    return transportError({ message: "HTTP transport failed" })
  }
  const request = "request" in error ? error.request : undefined
  if (error.reason._tag === "TransportError") {
    return transportError({
      message: error.reason.description ?? "HTTP transport failed",
      kind: error.reason._tag,
      request,
    })
  }
  return transportError({
    message: `HTTP transport failed: ${error.reason._tag}`,
    kind: error.reason._tag,
    request,
  })
}

const retryDelay = (error: LLMError, attempt: number) => {
  if (error.retryAfterMs !== undefined) return Effect.succeed(Math.min(error.retryAfterMs, MAX_DELAY_MS))
  return Random.nextBetween(
    Math.min(BASE_DELAY_MS * 2 ** attempt * 0.8, MAX_DELAY_MS),
    Math.min(BASE_DELAY_MS * 2 ** attempt * 1.2, MAX_DELAY_MS),
  ).pipe(Effect.map((delay) => Math.round(delay)))
}

const RetryBudget = Context.Reference<{ used: number } | undefined>("@zaovra/LLM/RetryBudget", {
  defaultValue: () => undefined,
})

const waitForRetry = (error: LLMError, budget: { used: number }) =>
  Effect.gen(function* () {
    if (budget.used >= MAX_RETRIES) return yield* error
    const attempt = budget.used++
    const delay = yield* retryDelay(error, attempt)
    const observe = yield* RetryObserver
    yield* observe({ attempt: attempt + 2, delayMs: delay, error })
    yield* Effect.logInfo("provider.request.retry", {
      attempt: attempt + 2,
      delayMs: delay,
      category: error.reason._tag,
      ...(error.reason._tag === "Transport" ? error.reason.diagnostics : {}),
    })
    yield* Effect.sleep(delay)
  })

const retryStatusFailures = <A, R>(
  effect: Effect.Effect<A, LLMError, R>,
  budget: { used: number },
): Effect.Effect<A, LLMError, R> =>
  Effect.catchTag(effect, "LLM.Error", (error): Effect.Effect<A, LLMError, R> => {
    // This wraps request admission only. A successful response leaves this
    // boundary before streaming, so retrying cannot replay emitted output.
    if (!error.retryable) return Effect.fail(error)
    return waitForRetry(error, budget).pipe(Effect.flatMap(() => retryStatusFailures(effect, budget)))
  })

/** Connection and pre-output read failures share one bounded retry allowance. */
export const retryBeforeOutput = (stream: Stream.Stream<LLMEvent, LLMError>) =>
  Stream.unwrap(
    Effect.sync(() => {
      const budget = { used: 0 }
      const attempt = (): Stream.Stream<LLMEvent, LLMError> =>
        Stream.unwrap(
          Effect.sync(() => {
            let committed = false
            const pending: LLMEvent[] = []
            return stream.pipe(
              Stream.map((event) => {
                // Metadata may contain encrypted reasoning. Only metadata-free starts
                // are buffered; all tool, usage and terminal events commit immediately.
                if (
                  !committed &&
                  pending.length < 32 &&
                  (event.type === "step-start" ||
                    ((event.type === "text-start" || event.type === "reasoning-start") && !event.providerMetadata))
                ) {
                  pending.push(event)
                  return []
                }
                committed = true
                return [...pending.splice(0), event]
              }),
              Stream.flattenIterable,
              Stream.concat(Stream.unwrap(Effect.sync(() => Stream.fromIterable(pending.splice(0))))),
              Stream.catchTag("LLM.Error", (error) => {
                if (committed || error.reason._tag !== "Transport" || error.reason.kind !== "StreamReadError")
                  return Stream.concat(Stream.fromIterable(pending.splice(0)), Stream.fail(error))
                // A disconnected attempt may have unreported provider billing.
                return Stream.unwrap(waitForRetry(error, budget).pipe(Effect.map(() => attempt())))
              }),
            )
          }),
        )
      return attempt().pipe(Stream.provideService(RetryBudget, budget))
    }),
  )

export const layer: Layer.Layer<Service, never, HttpClient.HttpClient> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const executeOnce = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.gen(function* () {
        const redactedNames = yield* Headers.CurrentRedactedNames
        const started = Date.now()
        yield* Effect.logInfo("provider.request.start", { host: new URL(request.url).hostname })
        return yield* http.execute(request).pipe(
          Effect.timeout(REQUEST_TIMEOUT),
          Effect.mapError(toHttpError(redactedNames)),
          Effect.tap((response) =>
            Effect.logInfo("provider.request.headers", {
              status: response.status,
              elapsedMs: Date.now() - started,
              requestID: requestId(normalizedHeaders(response.headers)),
            }),
          ),
          Effect.flatMap(statusError(request, redactedNames)),
          Effect.tapError((error) =>
            Effect.logInfo("provider.request.failed", {
              category: error.reason._tag,
              elapsedMs: Date.now() - started,
              ...(error.reason._tag === "Transport" ? error.reason.diagnostics : {}),
              status: "http" in error.reason ? error.reason.http?.response?.status : undefined,
            }),
          ),
        )
      })
    return Service.of({
      execute: (request) =>
        Effect.gen(function* () {
          const budget = (yield* RetryBudget) ?? { used: 0 }
          return yield* retryStatusFailures(executeOnce(request), budget)
        }),
    })
  }),
)

export const fetchLayer = layer.pipe(Layer.provide(FetchHttpClient.layer))

export * as RequestExecutor from "./executor"
