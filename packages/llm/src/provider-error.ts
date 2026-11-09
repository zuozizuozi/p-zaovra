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
  messageSource?: "structured" | "body" | "status"
  quota?: boolean
  parameter?: string
  code?: string
  type?: string
  status?: number
  retryAfterMs?: number
  http?: HttpContext
}) {
  const code = [input.code, input.type].filter(Boolean).join(" ").toLowerCase()
  const diagnostic = input.code ?? input.type
  // Protocol codecs supply decoded error fields; HTTP callers must identify their extraction source.
  const messageSource = input.messageSource ?? (input.http ? undefined : "structured")
  const common = {
    message: input.message,
    http: input.http,
    providerMetadata: { diagnostic: { code: diagnostic, messageSource } },
  }
  const detail = code || input.message
  if (
    (input.status === undefined || input.status === 400 || input.status === 422) &&
    code.split(/\s+/).includes("invalid_encrypted_content")
  )
    return new InvalidRequestReason({
      ...common,
      providerMetadata: { ...common.providerMetadata, compatibility: { code: "invalid_encrypted_content" } },
    })
  if (input.quota || isQuotaExceeded(code + " " + input.message)) return new QuotaExceededReason(common)
  if (/content_filter|content[-_\s]?policy|safety|permission_denied/i.test(detail))
    return /permission_denied/.test(code)
      ? new AuthenticationReason({ ...common, kind: "insufficient-permissions" })
      : new ContentPolicyReason(common)
  if (/invalid_api_key|authentication_error|unauthorized|access_denied|forbidden/.test(code))
    return new AuthenticationReason({ ...common, kind: input.status === 403 ? "insufficient-permissions" : "invalid" })
  const parameter = input.parameter ?? reasoningParameterConstraint(input.message)
  if (
    ![401, 402, 403, 429, 529].includes(input.status ?? 0) &&
    !/context_length_exceeded/.test(code) &&
    !isContextOverflow(input.message) &&
    parameter
  )
    return new InvalidRequestReason({
      ...common,
      message: `${input.message}\n当前推理档位超出该模型或服务的上限，请降一档。`,
      parameter,
    })
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

/** Only a named reasoning parameter and its own constraint justify stopping recovery. */
export function reasoningParameterConstraint(message: string) {
  if (/\btools?\s+with\s+reasoning(?:_effort)?\b/i.test(message)) return
  return (
    /\b(thinking_budget|reasoning_budget|reasoning_effort|thinking[._]budget_tokens)\b[\s\x22\x27`:=0-9()\[\]-]{0,40}(?:must (?:not |be )*(?:greater|less|at most|at least|between|one of|[<>]=?)|should (?:not |be )*(?:greater|less|between|[<>]=?)|(?:is |are )?(?:not supported|unsupported|out of range)|(?:exceeds?|above|below) (?:the )?(?:maximum|minimum|upper|lower|supported)|不(?:得|能|应)(?:大于|小于)|超出.{0,16}(?:上限|范围))/i.exec(
      message,
    )?.[1] ??
    /(?:unsupported|invalid) (?:value for |reasoning )?(?:parameter[ :]+)?[\x22\x27` ]*\b(thinking_budget|reasoning_budget|reasoning_effort|thinking[._]budget_tokens)\b/i.exec(
      message,
    )?.[1]
  )?.toLowerCase()
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
  /range of input length should be\s*\[\s*1\s*,\s*\d+\s*\]/i,
  /context length is only \d+ tokens/i,
  /input length.*exceeds.*context length/i,
  /prompt too long; exceeded (?:max )?context length/i,
  /too large for model with \d+ maximum context length/i,
  /model_context_window_exceeded/i,
]

export const isContextOverflow = (message: string) => patterns.some((pattern) => pattern.test(message))

export const isContextOverflowFailure = (failure: unknown) =>
  failure instanceof LLMError
    ? failure.reason._tag === "InvalidRequest" && failure.reason.classification === "context-overflow"
    : Schema.is(ProviderErrorEvent)(failure) && failure.classification === "context-overflow"
