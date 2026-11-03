/** A closed read-only archive workflow. No script evaluation or generic PowerShell interpretation. */
export function powerShellArchivePath(command: string) {
  if (command.length > 16_384) return
  const identifier = "[A-Za-z_][A-Za-z0-9_]*"
  const literal = "(?:" + /'(?:[^']|'')*'|"[^"$\x60]*"/.source + ")"
  const separator = "\\s*(?:;|\\r?\\n)\\s*"
  const pattern = new RegExp(
    "^\\s*(?:\\$ErrorActionPreference\\s*=\\s*'Stop'" +
      separator +
      ")?" +
      "Add-Type\\s+-AssemblyName\\s+System\\.IO\\.Compression\\.FileSystem" +
      separator +
      "\\$(" +
      identifier +
      ")\\s*=\\s*(" +
      literal +
      ")" +
      separator +
      "\\$(" +
      identifier +
      ")\\s*=\\s*\\[System\\.IO\\.Compression\\.ZipFile\\]::OpenRead\\(\\s*\\$\\1\\s*\\)" +
      separator +
      "(?:\\$\\3\\.Entries\\s*\\|\\s*Select-Object\\s+(?:-Property\\s+)?FullName\\s*,\\s*Length\\s*\\|\\s*Format-Table\\s+-AutoSize" +
      separator +
      ")?" +
      "\\$(" +
      identifier +
      ")\\s*=\\s*\\$\\3\\.Entries\\s*\\|\\s*Where-Object\\s*\\{\\s*\\$_\\.FullName\\s+-eq\\s+" +
      literal +
      "\\s*\\}" +
      separator +
      "if\\s*\\(\\s*\\$\\4\\s*\\)\\s*\\{\\s*\\$(" +
      identifier +
      ")\\s*=\\s*New-Object\\s+System\\.IO\\.StreamReader\\(\\s*\\$\\4\\.Open\\(\\s*\\)\\s*\\)" +
      separator +
      "\\$(" +
      identifier +
      ")\\s*=\\s*\\$\\5\\.ReadToEnd\\(\\s*\\)" +
      separator +
      "\\$\\5\\.Close\\(\\s*\\)" +
      separator +
      "Write-Output\\s*\\(\\s*" +
      literal +
      "\\s*\\+\\s*\\$\\6\\.Length\\s*\\)\\s*;?\\s*\\}" +
      separator +
      "\\$\\3\\.Dispose\\(\\s*\\)\\s*;?\\s*$",
    "i",
  )
  const match = pattern.exec(command)
  if (
    !match ||
    new Set([match[1], match[3], match[4], match[5], match[6]].map((name) => name.toLowerCase())).size !== 5
  )
    return
  // Do not accept assignments to automatic variables or special PowerShell scopes.
  if (
    [match[1], match[3], match[4], match[5], match[6]].some((name) =>
      /^(?:_|args|input|this|true|false|null|HOME|PWD|PSHOME|PSItem|ErrorActionPreference)$/i.test(name),
    )
  )
    return
  const quoted = match[2]
  const value = quoted.slice(1, -1).replace(/''/g, "'")
  if (!value || /[\r\n\0]/.test(value)) return
  return value
}

/** Resolve sequential, literal-only local bindings; unknown values keep their original expansion risk. */
export function powerShellLiterals(command: string) {
  if (command.length > 16_384) return command
  if (
    /\b(?:Set-Variable|New-Variable|Remove-Variable|Clear-Variable|Invoke-Expression|iex|Set-Item|New-Item|ForEach-Object)\b/i.test(
      command,
    ) ||
    /[{}\u0060]|--%/.test(command)
  )
    return command
  const statements: string[] = []
  const pieces = command.match(/'(?:[^']|'')*'|"[^"]*"|[^;\r\n'"]+|[;\r\n]/g) ?? []
  if (pieces.join("") !== command) return command
  let statement = ""
  for (const piece of pieces) {
    if (/^[;\r\n]$/.test(piece)) {
      statements.push(statement)
      statement = ""
      continue
    }
    statement += piece
  }
  statements.push(statement)
  const values = new Map<string, string>()
  const result: string[] = []
  for (const part of statements) {
    const assignment = /^\s*\$([A-Za-z_]\w*)\s*=\s*('(?:[^']|'')*'|"[^"\u0024\u0060]*"|[+-]?\d+(?:\.\d+)?)\s*$/.exec(
      part,
    )
    if (assignment) {
      const quoted = /^['"]/.test(assignment[2])
      const value = quoted ? assignment[2].slice(1, -1).replace(/''/g, "'") : assignment[2]
      if (/['"\u0024\u0060%\r\n]/.test(value) || /^(?:_|args|input|this|HOME|PWD|PSHOME|PSItem)$/i.test(assignment[1]))
        return command
      values.set(assignment[1].toLowerCase(), value)
      result.push('Write-Output "' + value + '"')
      continue
    }
    if (/\$[\w:]+\s*(?:\+\+|--|[+*\/-]?=)/.test(part) || /\b(?:bash|pwsh|powershell|cmd|Invoke-Command)\b/i.test(part))
      return command
    const outside = part.replace(/'(?:[^']|'')*'|"[^"]*"/g, '""')
    if (/[()[\]{}&]/.test(outside)) return command
    if (
      outside
        .split("|")
        .some(
          (segment) =>
            segment.trim() &&
            !/^\s*(?:Get-Content|Get-ChildItem|Get-Item|Test-Path|Select-Object|Select-String|Measure-Object|Format-Table|Write-Output|Write-Host|Copy-Item|Move-Item|Remove-Item|Set-Content|Add-Content|Out-File|cat|type|ls|dir|echo|pwd|cd|Set-Location)\b/i.test(
              segment,
            ),
        )
    )
      return command
    result.push(
      (part.match(/'(?:[^']|'')*'|"[^"]*"|[^'"]+/g) ?? [])
        .map((token) => {
          if (token.startsWith("'")) return token
          return token.replace(
            /\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*(?::\w+)?)/g,
            (original, braced: string | undefined, plain: string | undefined) => {
              const value = values.get((braced ?? plain ?? "").toLowerCase())
              if (value === undefined) return original
              return token.startsWith('"') ? value : '"' + value + '"'
            },
          )
        })
        .join(""),
    )
  }
  return result.join(";")
}
