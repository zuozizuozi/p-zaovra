import path from "node:path"

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
      ? token.slice(1, -1).replace(/''/g, "'")
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
