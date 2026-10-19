import path from "node:path"
import type { ShellIdentity } from "../shell-identity"

// This recognizes only a literal command prefix, not arbitrary shell programs.
// Undefined means that the effective environment cannot be certified.
export function commandEnvironment(command: string, shell: ShellIdentity.Identity["type"]) {
  if (shell === "cmd") return undefined
  const values: Record<string, string | null> = {}
  let rest = command.trimStart()
  if (shell === "powershell") {
    while (true) {
      const assignment = rest.match(/^\$env:([a-z_][a-z0-9_]*)\s*=\s*/i)
      if (!assignment) break
      const value = word(rest.slice(assignment[0].length), shell)
      if (!value) return undefined
      values[assignment[1].toUpperCase()] = value.dynamic ? null : value.text
      rest = value.rest.trimStart()
      if (!rest.startsWith(";")) return undefined
      rest = rest.slice(1).trimStart()
    }
    if (rest.startsWith("&")) rest = rest.slice(1).trimStart()
  }
  let executable = ""
  let env = false
  while (rest && !rest.startsWith("#")) {
    const token = word(rest, shell)
    if (!token) return undefined
    // A newline starts another command, not another argument.
    if (/^[ \t]*[\r\n]/.test(token.rest)) return undefined
    rest = token.rest.trimStart()
    if (!executable && shell !== "powershell") {
      const assignment = (env ? token.text : token.raw).match(/^([a-zA-Z_][a-zA-Z0-9_]*)=/)
      if (assignment) {
        values[assignment[1]] = token.dynamic ? null : token.text.slice(token.text.indexOf("=") + 1)
        continue
      }
      if (!env && path.posix.basename(token.text).replace(/\.exe$/i, "") === "env") {
        env = true
        continue
      }
    }
    if (token.dynamic) return undefined
    if (!executable) {
      executable = token.text
        .replaceAll("\\", "/")
        .split("/")
        .at(-1)!
        .replace(/\.exe$/i, "")
        .toLowerCase()
      // Wrappers, eval and environment-changing builtins need a richer parser.
      if (
        executable.startsWith("-") ||
        [
          "env",
          "bash",
          "sh",
          "dash",
          "zsh",
          "fish",
          "pwsh",
          "powershell",
          "cmd",
          "eval",
          "exec",
          "command",
          "builtin",
          "nohup",
          "sudo",
          "source",
          ".",
          "export",
          "set",
          "unset",
          "set-item",
          "set-variable",
          "remove-item",
          "invoke-expression",
          "iex",
          "start-process",
        ].includes(executable)
      )
        return undefined
    }
  }
  return executable ? values : undefined
}

function word(input: string, shell: ShellIdentity.Identity["type"]) {
  let quote = ""
  let text = ""
  let dynamic = false
  let index = 0
  for (; index < input.length; index++) {
    const char = input[index]
    if (!quote && /[\s;|&<>]/.test(char)) break
    if (char === quote) {
      if (shell === "powershell" && quote === "'" && input[index + 1] === "'") {
        text += "'"
        index++
        continue
      }
      quote = ""
      continue
    }
    if (!quote && (char === "'" || char === '"')) {
      quote = char
      continue
    }
    if (quote !== "'" && ((shell === "powershell" && char === "`") || (shell !== "powershell" && char === "\\"))) {
      if (input[index + 1] === undefined) return undefined
      // Escapes are deliberately unknown rather than guessing shell-specific expansion.
      dynamic = true
      text += input[++index]
      continue
    }
    if (quote !== "'" && (char === "$" || char === "`" || (!quote && /[(){}\[\]*?~]/.test(char)))) dynamic = true
    text += char
  }
  if (!index || quote) return undefined
  return { text, raw: input.slice(0, index), dynamic, rest: input.slice(index) }
}
