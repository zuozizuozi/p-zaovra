export function artifactPath(input: string, directory: string, encoded = false) {
  const valueIsURL = encoded || /^file:\/\//i.test(input.trim())
  // File-list entries and inline paths are literal file names, not URL-encoded strings.
  // Keep encoded traversal rejected even when it arrives through a literal-path entry point.
  if (!valueIsURL && /%(?:2e|2f|5c|00)/i.test(input)) return
  const decoded = (() => {
    const value = input.trim().replace(/^file:\/\//i, "")
    if (!valueIsURL) return value
    try {
      return decodeURIComponent(value)
    } catch {
      return ""
    }
  })()
  if (!decoded || /[\r\n\0]/.test(decoded)) return
  const line = decoded.match(/(?::(\d+)|#L(\d+))$/)
  const value = decoded
    .replace(/(?::\d+|#L\d+)$/, "")
    .replaceAll("\\", "/")
    .replace(/^\/([a-z]:\/)/i, "$1")
  const root = directory.replaceAll("\\", "/").replace(/\/$/, "")
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[a-z]:\//i.test(value)) return
  const absolute = /^(?:[a-z]:\/|\/)/i.test(value)
  const windows = /^[a-z]:/i.test(root)
  const candidate = windows ? value.toLowerCase() : value
  const boundary = windows ? root.toLowerCase() : root
  if (absolute && !candidate.startsWith(boundary + "/")) return
  const parts: string[] = []
  for (const part of (absolute ? value.slice(root.length + 1) : value).split("/")) {
    if (!part || part === ".") continue
    if (part === "..") {
      if (!parts.length) return
      parts.pop()
      continue
    }
    if (part.includes(":")) return
    parts.push(part)
  }
  if (!parts.length) return
  return { path: parts.join("/"), line: line ? Number(line[1] ?? line[2]) : undefined }
}

export const artifactPreviewable = (path: string) =>
  /\.(?:html?|png|jpe?g|gif|webp|svg|ico|pdf|mp4|webm|mp3|wav)$/i.test(path)
