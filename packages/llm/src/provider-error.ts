import { Schema } from "effect"
import {
  AuthenticationReason,
  ContentPolicyReason,
  HttpContext,
  InvalidRequestReason,
  LLMError,
  ProviderErrorEvent,
  ProviderInternalReason,
  QuotaExceededReason,
  RateLimitReason,
  UnknownProviderReason,
} from "./schema"

/** Use provider codes before HTTP fallbacks; generic messages must not imply transience. */
export function providerFailure(input: {
  message: string
  quota?: boolean
  code?: string
  type?: string
  status?: number
  retryAfterMs?: number
  http?: HttpContext
}) {
  const code = [input.code, input.type].filter(Boolean).join(" ").toLowerCase()
  const common = { message: input.message, http: input.http }
  const detail = code || input.message
  if (input.quota || isQuotaExceeded(code + " " + input.message)) return new QuotaExceededReason(common)
  if (/content_filter|content[-_\s]?policy|safety|permission_denied/i.test(detail))
    return /permission_denied/.test(code)
      ? new AuthenticationReason({ ...common, kind: "insufficient-permissions" })
      : new ContentPolicyReason(common)
  if (/invalid_api_key|authentication_error|unauthorized|access_denied|forbidden/.test(code))
    return new AuthenticationReason({ ...common, kind: input.status === 403 ? "insufficient-permissions" : "invalid" })
  if (
    /invalid_request|invalid_argument|invalid_prompt|bad_request|context_length_exceeded|model_not_found|unsupported/.test(
      code,
    ) ||
    (input.status !== undefined && [400, 413, 422].includes(input.status) && isContextOverflow(input.message))
  )
    return new InvalidRequestReason({
      ...common,
      classification:
        /context_length_exceeded/.test(code) || isContextOverflow(input.message) ? "context-overflow" : undefined,
    })
  if (/rate[-_\s]?limit|too[_ ]many[_ ]requests|throttl|请求频率|限流/i.test(detail) || input.status === 429)
    return new RateLimitReason({ ...common, retryAfterMs: input.retryAfterMs, rateLimit: input.http?.rateLimit })
  if (
    /overload|over capacity|temporarily unavailable|server_error|internal_error|service_unavailable|过载|暂时不可用/i.test(
      detail,
    ) ||
    (input.status ?? 0) >= 500 ||
    [408, 425].includes(input.status ?? 0)
  )
    return new ProviderInternalReason({ ...common, status: input.status ?? 503, retryAfterMs: input.retryAfterMs })
  if (input.status === 401 || input.status === 403)
    return new AuthenticationReason({ ...common, kind: input.status === 403 ? "insufficient-permissions" : "invalid" })
  if (input.status === 402) return new QuotaExceededReason(common)
  if ([400, 404, 409, 413, 422].includes(input.status ?? 0)) return new InvalidRequestReason(common)
  return new UnknownProviderReason({ ...common, status: input.status })
}

export const isQuotaExceeded = (value: string) =>
  /insufficient[-_\s]?(?:quota|balance|credits)|(?<!token_)quota[-_\s]?exceeded|billing[-_\s]?hard[-_\s]?limit|free-models-per-day|openrouter_free_tier_daily|余额不足|额度不足/i.test(
    value,
  )

export function providerEventError(event: ProviderErrorEvent) {
  return new LLMError({
    module: "Provider",
    method: "stream",
    reason:
      event.classification === "context-overflow"
        ? new InvalidRequestReason({ message: event.message, classification: "context-overflow" })
        : (event.reason ?? providerFailure(event)),
  })
}

const patterns = [
  /prompt is too long/i,
  /input is too long for requested model/i,
  /exceeds the context window/i,
  /input token count.*exceeds the maximum/i,
  /tokens in request more than max tokens allowed/i,
  /maximum prompt length is \d+/i,
  /reduce the length of the messages/i,
  /maximum context length is \d+ tokens/i,
  /exceeds the limit of \d+/i,
  /exceeds the available context size/i,
  /greater than the context length/i,
  /context window exceeds limit/i,
  /exceeded model token limit/i,
  /context[_ ]length[_ ]exceeded/i,
  /request entity too large/i,
  /context length is only \d+ tokens/i,
  /input length.*exceeds.*context length/i,
  /prompt too long; exceeded (?:max )?context length/i,
  /too large for model with \d+ maximum context length/i,
  /model_context_window_exceeded/i,
]

export const isContextOverflow = (message: string) =>
  patterns.some((pattern) => pattern.test(message)) || /^4(00|13)\s*(status code)?\s*\(no body\)/i.test(message)

export const isContextOverflowFailure = (failure: unknown) =>
  failure instanceof LLMError
    ? failure.reason._tag === "InvalidRequest" && failure.reason.classification === "context-overflow"
    : Schema.is(ProviderErrorEvent)(failure) && failure.classification === "context-overflow"
