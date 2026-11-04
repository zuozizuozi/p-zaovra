import path from "node:path"
import { domainToUnicode } from "node:url"

/** Lexical literal operands only: never evaluates PowerShell, variables, types or cmdlets. */
export function powerShellLiteralOperands(command: string) {
  if (command.length > 16_384) return { paths: [], complete: false }
  const tokens = command.match(/'(?:[^']|'')*'|"(?:`[\s\S]|[^"`])*"|["']|[^"'\s;&|<>(){},[\]]+/g) ?? []
  let complete = true
  const paths = tokens.flatMap((token, index) => {
    if (token === "'" || token === '\"') {
      complete = false
      return []
    }
    const quoted = /^["']/.test(token)
    let value = quoted
      ? token.startsWith("'")
        ? token.slice(1, -1).replace(/''/g, "'")
        : token.slice(1, -1)
      : token.replace(/^(?:--[^=]+|[A-Za-z_][\w]*)=|^-\w+:/, "").replace(/^\$[\w:]+=/, "")
    if (
      !quoted &&
      ((index === 0 && !path.isAbsolute(value) && !/[\\/]/.test(value)) || value.startsWith("-") || /[$`]/.test(value))
    )
      return []
    if (token.startsWith('"') && /[$`]/.test(value)) {
      // A fixed directory prefix still requires its own authorization, even
      // when the rest of an interpolated path is unknown.
      value = value.slice(0, value.search(/[$`]/))
      if (!/[\\/]/.test(value)) return []
    }
    if (/^file:/i.test(value)) {
      // Uri.LocalPath is a filesystem operand too. Invalid/ambiguous URI
      // literals must not silently become a complete workspace-only scan.
      if (!/^file:\/\//i.test(value) || !URL.canParse(value)) {
        complete = false
        return []
      }
      const url = new URL(value)
      try {
        if (url.search || url.hash || /%2f|%5c/i.test(url.pathname)) throw new Error("Ambiguous file URI")
        // Bun 1.3.14 ignores fileURLToPath's Windows option and tolerates invalid
        // escapes. Decode strictly and retain the URI's drive/UNC identity on
        // every host, so a Linux scan cannot silently omit a Windows literal.
        const pathname = decodeURIComponent(url.pathname)
        const hostname = domainToUnicode(url.hostname)
        const drive = /^\/[A-Za-z]:\//.test(pathname)
        const windows = process.platform === "win32" || drive || !!url.hostname
        if ((url.hostname && !hostname) || (windows && !hostname && !drive)) throw new Error("Invalid file URI")
        value = windows
          ? hostname
            ? "\\\\" + hostname + pathname.replaceAll("/", "\\")
            : pathname.slice(1).replaceAll("/", "\\")
          : pathname
        if (/[\r\n\0<>|?*]/.test(value) || /:/.test(value.replace(/^[A-Za-z]:/, "")))
          throw new Error("Invalid file path")
      } catch {
        complete = false
        return []
      }
    }
    // Normalize extended drive/UNC paths before '?' can be read as a glob.
    if (/^[\\/]{2}\?[\\/]/.test(value)) {
      const target = value.slice(4).replaceAll("/", "\\")
      if (/^UNC\\/i.test(target)) value = "\\\\" + target.slice(4)
      else if (/^[A-Za-z]:[\\/]/.test(target)) value = target
      else {
        complete = false
        return []
      }
    }
    // Non-filesystem labels (for example a status message or a type member)
    // must not be handed to the Windows path resolver as malformed paths.
    if (!value || /[\r\n\0<>|]/.test(value) || /:/.test(value.replace(/^[A-Za-z]:/, ""))) return []
    if (/[?*]/.test(value)) {
      value = value.slice(0, value.search(/[?*]/))
      value = value.slice(0, Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\")) + 1)
      if (!value) return []
    }
    return [value]
  })
  return { paths: [...new Set(paths)].slice(0, 256), complete: complete && paths.length <= 256 }
}
