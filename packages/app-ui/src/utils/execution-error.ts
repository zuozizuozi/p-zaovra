type Translator = (key: string) => string

// Details come from the existing provider error redaction path. Keep them intact:
// the explanation must not hide a gateway's more specific failure reason.
export function explainExecutionError(detail: string, translate: Translator) {
  const status = detail.match(/(?:^|\b(?:HTTP|status(?:_code| code)?))\s*[:=]?\s*([45]\d{2})\b/i)?.[1]
  const key =
    status === "401" || status === "403" || /unauthorized|authentication|invalid.api.key/i.test(detail)
      ? "auth"
      : status === "402" || /insufficient.(?:balance|credit)|account.expired/i.test(detail)
        ? "billing"
        : status === "429" || /rate.limit|too.many.requests/i.test(detail)
          ? "rateLimit"
          : status === "404" || /not implemented|unsupported.*(?:protocol|endpoint)/i.test(detail)
            ? "protocol"
            : /context.length|context.window|maximum.context/i.test(detail)
              ? "context"
              : /timeout|timed.out|ETIMEDOUT/i.test(detail)
                ? "timeout"
                : /ECONNRESET|ECONNREFUSED|ENOTFOUND|fetch failed|network error/i.test(detail)
                  ? "network"
                  : /^50[0-4]$/.test(status ?? "") || /internal.server.error|service.unavailable/i.test(detail)
                    ? "provider"
                    : undefined
  if (!key) return detail
  const message = translate(`error.execution.${key}`)
  return `${message}\n\n${detail}`
}
