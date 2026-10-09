// Debug output is shareable; header/env values and credential fields are not.
export function redactConfig(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactConfig)
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /key|token|secret|password|credential|authorization|headers|^env$|^environment$/i.test(key)
          ? "[REDACTED]"
          : redactConfig(item),
      ]),
    )
  if (typeof value !== "string") return value
  const url = URL.parse(value)
  if (!url) return value
  if (url.username) url.username = "REDACTED"
  if (url.password) url.password = "REDACTED"
  // Query names are provider-specific, so no query values are safe to print.
  for (const key of Array.from(url.searchParams.keys())) url.searchParams.set(key, "REDACTED")
  if (url.hash) url.hash = "REDACTED"
  return url.href
}
