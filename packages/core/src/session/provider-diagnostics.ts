export * as ProviderDiagnostics from "./provider-diagnostics"

import { LLMError, type ProviderErrorEvent } from "@zaovra-ai/llm"
import { Feedback } from "@zaovra-ai/schema/feedback"

/** Only proven structured summaries enter default diagnostics; HTTP bodies remain opt-in. */
export function metadata(error: LLMError | ProviderErrorEvent): Record<string, string> {
  const reason = error.reason
  const http = reason && "http" in reason ? reason.http : undefined
  const diagnostic = reason && "providerMetadata" in reason ? reason.providerMetadata?.diagnostic : undefined
  if (error instanceof LLMError && !diagnostic && (http?.response?.status ?? 0) < 400) return {}
  return {
    ...Feedback.providerDiagnostic({
      code: error instanceof LLMError ? diagnostic?.code : (error.code ?? diagnostic?.code),
      message: reason?.message ?? error.message,
      source: diagnostic?.messageSource ?? (!(error instanceof LLMError) && !reason ? "structured" : undefined),
    }),
    ...(http?.requestId ? { requestID: Feedback.redact(http.requestId).slice(0, 128) } : {}),
  }
}
