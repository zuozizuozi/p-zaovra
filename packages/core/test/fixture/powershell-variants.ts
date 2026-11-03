import path from "node:path"
import { archiveInspection } from "./powershell-archive"

export function powerShellVariants(file: string) {
  const quoted = file.replaceAll("'", "''")
  return [
    archiveInspection(file),
    `Expand-Archive -LiteralPath '${quoted}' -DestinationPath 'expanded'`,
    `$folder='${path.dirname(file).replaceAll("'", "''")}'; Get-ChildItem $folder | Where-Object { $_.Extension -eq '.xlsx' }`,
    `$renamed='${quoted}'; Get-Item $renamed`,
    `$value=[IO.File]::ReadAllText('${quoted}'); Write-Output $value.Length`,
    `$csv='${quoted}'; $rows=Import-Csv $csv; $rows | Select-Object -First 1`,
  ]
}
