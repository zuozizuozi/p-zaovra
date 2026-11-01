import path from "node:path"
import type { ShellIdentity } from "../shell-identity"

/** Narrow literal-operand scan, never a shell parser or an OS sandbox. */
export function analyzeCommand(command: string, shell: ShellIdentity.Identity["type"]) {
  const tokens = command.match(/"[^"]*"|'[^']*'|[^\s"';&|<>]+/g) ?? []
  const unquoted = command.replace(/"[^"]*"|'[^']*'/g, "")
  const dynamic = shell === "cmd" ? command : command.replace(/'[^']*'/g, "")
  const nested = tokens.some((token) =>
    /^(?:bash|sh|zsh|pwsh|powershell|cmd)(?:\.exe)?$/i.test(path.basename(token.replace(/^(["'])(.*)\1$/, "$2"))),
  )
  const interpreter = tokens.some((token) =>
    /^(?:python[\d.]*|node|ruby|perl)(?:\.exe)?$/i.test(path.basename(token.replace(/^(["'])(.*)\1$/, "$2"))),
  )
  const inline = interpreter && tokens.some((token) => token === "-c" || token === "-e")
  const paths = tokens.flatMap((token) => {
    const quoted = /^["']/.test(token)
    const value = token.replace(/^(["'])(.*)\1$/, "$2").replace(/^(?:--[^=]+|[A-Za-z_][\w]*)=|^-[A-Za-z]+:/, "")
    if (/[\r\n$`%]/.test(value) || (!quoted && /[?*\[\]{}]/.test(value))) return []
    if (shell === "cmd" && /^\/[A-Za-z](?::|$)/.test(value)) return []
    return path.isAbsolute(value) || /^\.\.?[\\/]/.test(value) ? [value] : []
  })
  const foreignSyntax =
    process.platform === "win32" &&
    (shell === "bash" || shell === "posix") &&
    paths.some((value) => value.startsWith("/"))
  const uncertain =
    /[\r\n\u2028\u2029;&|<>()`"'~]/.test(unquoted) ||
    /[$`]/.test(dynamic) ||
    (shell === "powershell" && /\b[A-Za-z_][\w]+:/.test(dynamic)) ||
    /^\s*\.\s/.test(unquoted) ||
    ((shell === "bash" || shell === "posix") && /\\/.test(unquoted)) ||
    (shell === "cmd" && /[%!^']/.test(command)) ||
    /[?*\[\]{}]/.test(unquoted) ||
    /\b(?:cd|pushd|popd|Set-Location)\b/i.test(unquoted) ||
    nested ||
    inline ||
    foreignSyntax ||
    paths.length > 256
  return {
    paths: [...new Set(paths)].filter((value) => !foreignSyntax || !value.startsWith("/")).slice(0, 256),
    uncertain,
  }
}
