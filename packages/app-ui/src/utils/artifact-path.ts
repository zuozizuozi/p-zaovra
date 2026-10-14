export function artifactPath(input: string, directory: string, encoded = false) {
  const valueIsURL = encoded || /^file:\/\//i.test(input.trim())
  // Split URL fragments before decoding: an encoded # belongs to the file name.
  // File-list entries remain literal, including percent escapes and #L suffixes.
  const source = valueIsURL ? input.trim() : input
  const fragment = valueIsURL ? source.indexOf("#") : -1
  const line = fragment >= 0 ? source.slice(fragment).match(/^#L(\d+)$/) : undefined
  const decoded = (() => {
    const value = (fragment >= 0 ? source.slice(0, fragment) : source).replace(/^file:\/\//i, "")
    if (!valueIsURL) return value
    try {
      return decodeURIComponent(value)
    } catch {
      return ""
    }
  })()
  if (!decoded || /[\r\n\0]/.test(decoded)) return
  const value = decoded.replaceAll("\\", "/").replace(/^\/([a-z]:\/)/i, "$1")
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
  return { path: parts.join("/"), line: line ? Number(line[1]) : undefined }
}

export const artifactPreviewable = (path: string) =>
  /\.(?:html?|png|jpe?g|gif|webp|svg|ico|pdf|mp4|webm|mp3|wav)$/i.test(path)
