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
  const paths = tokens.flatMap((token, index) => {
    const quoted = /^["']/.test(token)
    const value = token.replace(/^(["'])(.*)\1$/, "$2").replace(/^(?:--[^=]+|[A-Za-z_][\w]*)=|^-[A-Za-z]+:/, "")
    if (!value || value.startsWith("-")) return []
    if (/[\r\n$`%]/.test(value) || (!quoted && /[?*\[\]{}]/.test(value))) return []
    if (shell === "cmd" && /^\/[A-Za-z](?::|$)/.test(value)) return []
    // Ordinary operands can traverse or name an external symlink too. The command name still uses PATH lookup.
    return (index > 0 && !/[?*\[\]{}]/.test(value)) || path.isAbsolute(value) || /[\\/]/.test(value) ? [value] : []
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
  // Shell control flow alone is not an external-path boundary. Keep confirmation
  // for unresolved expansions/paths, not ordinary pipes, redirects or inline code.
  // Literal targets are resolved independently; this never inspects program contents.
  const externalRisk =
    /[$`]/.test(dynamic) ||
    /(?:^|[\s=])~(?:[\\/]|$)/.test(unquoted) ||
    /[?*\[\]{}"']/.test(unquoted) ||
    (shell === "powershell" && /\b[A-Za-z_][\w]+:/.test(dynamic)) ||
    ((shell === "bash" || shell === "posix") && /\\/.test(unquoted)) ||
    (shell === "cmd" && /[%!^']/.test(command)) ||
    /\b(?:cd|pushd|Set-Location)\s*(?:[;&|\r\n]|$)/i.test(unquoted) ||
    foreignSyntax ||
    paths.length > 256
  return {
    paths: [...new Set(paths)].filter((value) => !foreignSyntax || !value.startsWith("/")).slice(0, 256),
    uncertain,
    externalRisk,
  }
}
