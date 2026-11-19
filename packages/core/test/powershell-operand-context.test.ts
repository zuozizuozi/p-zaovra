import { expect, test } from "bun:test"
import { analyzeCommand, analyzeShellCommand } from "../src/tool/bash-preflight"

const displayBytes =
  "$p = Join-Path (Get-Location) 'beta-proof.txt'; $b = [System.IO.File]::ReadAllBytes($p); \"Length=$($b.Length)\"; \"Hex=\" + (($b | ForEach-Object { $_.ToString('X2') }) -join ' '); \"Text=\" + [System.Text.Encoding]::ASCII.GetString($b).Replace(\"`r\",'\\r').Replace(\"`n\",'\\n')"
const writeProof =
  '$path = "beta-proof.txt"; [System.IO.File]::WriteAllText((Resolve-Path -LiteralPath ".").Path + "\\" + $path, "RECOVERY_0`n", (New-Object System.Text.UTF8Encoding($false))); Get-Content -LiteralPath $path -Raw'

test("displaying escaped line endings does not request a drive-root directory", async () => {
  const scan = await analyzeShellCommand(displayBytes, "powershell")
  expect(scan.paths).not.toContain("\\r")
  expect(scan.paths).not.toContain("\\n")
  expect(scan.paths).toContain("beta-proof.txt")
})

test("a separator joined to the resolved working directory is not an independent root", async () => {
  const scan = await analyzeShellCommand(writeProof, "powershell")
  expect(scan.paths).not.toContain("\\")
  expect(scan.paths).toContain("beta-proof.txt")
})

test("identical literals in filesystem operands retain their independent checks", async () => {
  for (const target of ["\\r", "\\n", "\\"]) {
    const scan = await analyzeShellCommand(displayBytes + "; Get-Item -LiteralPath '" + target + "'", "powershell")
    expect(scan.paths).toContain(target)
  }
})
test("computed file operands and unparsed inputs keep their literal checks", async () => {
  const display = displayBytes.slice(displayBytes.indexOf("[System.Text.Encoding]"))
  for (const command of [
    "$file = " + display,
    "Get-Item (" + display + ")",
    display + " | Get-Item",
    display + " > log.txt",
    display + " (",
  ]) {
    expect((await analyzeShellCommand(command, "powershell")).paths, command).toContain("\\r")
  }
})

test("formatted replacement text can be displayed without treating its escape strings as files", async () => {
  const command =
    "$p = Join-Path (Get-Location) 'beta-proof.txt'; $b = [System.IO.File]::ReadAllBytes($p); Write-Output (\"Length={0}\" -f $b.Length); Write-Output (\"Hex={0}\" -f (($b | ForEach-Object { $_.ToString('X2') }) -join ' ')); Write-Output (\"Text={0}\" -f ([System.Text.Encoding]::UTF8.GetString($b) -replace \"`r\", '\\r' -replace \"`n\", '\\n'))"
  const scan = await analyzeShellCommand(command, "powershell")
  expect(scan.paths).toContain("beta-proof.txt")
  expect(scan.paths).not.toContain("\\r")
  expect(scan.paths).not.toContain("\\n")
  const display = command.slice(command.lastIndexOf("Write-Output"))
  for (const use of [
    display + "; Get-Item -LiteralPath '\\r'",
    display.replace("Write-Output", "Get-Item"),
    display + " | Get-Item",
    display + " > log.txt",
    "$file = " + display,
    display.replace("Write-Output", "Write-Output -OutVariable result"),
  ]) {
    expect((await analyzeShellCommand(use, "powershell")).paths, use).toContain("\\r")
  }
})

test("bracketed file contents use newline escapes only as standalone display text", async () => {
  const command =
    '$p = Join-Path $PWD \'beta-proof.txt\'; [System.IO.File]::WriteAllText($p, "RECOVERY_1A`n", (New-Object System.Text.UTF8Encoding($false))); $b = [System.IO.File]::ReadAllBytes($p); "LEN=$($b.Length)"; "HEX=" + (($b | ForEach-Object { $_.ToString(\'x2\') }) -join \' \'); "TEXT=[" + [System.IO.File]::ReadAllText($p).Replace("`n",\'\\n\') + "]"'
  const scan = await analyzeShellCommand(command, "powershell")
  expect(scan.paths).toContain("beta-proof.txt")
  expect(scan.paths).not.toContain("\\n")
  expect(scan.externalRisk).toBe(analyzeCommand(command, "powershell").externalRisk)

  const display = command.slice(command.lastIndexOf('"TEXT=['))
  for (const command of ["$text = " + display, display + " > log.txt", display + "; Get-Item -LiteralPath '\\n'"]) {
    expect((await analyzeShellCommand(command, "powershell")).paths, command).toContain("\\n")
  }
})

test("Write-Output of bracketed file contents keeps only file operands", async () => {
  const command =
    "$p = Join-Path (Get-Location) 'beta-proof.txt'; [System.IO.File]::WriteAllText($p, \"RECOVERY_0`n\", (New-Object System.Text.UTF8Encoding($false))); $b = [System.IO.File]::ReadAllBytes($p); Write-Output (\"bytes=\" + ($b -join ',')); Write-Output (\"text=[\" + [System.IO.File]::ReadAllText($p).Replace(\"`r\",\"\\r\").Replace(\"`n\",\"\\n\") + \"]\")"
  const scan = await analyzeShellCommand(command, "powershell")
  expect(scan.paths).toContain("beta-proof.txt")
  expect(scan.paths).not.toContain("\\r")
  expect(scan.paths).not.toContain("\\n")
  const display = command.slice(command.lastIndexOf("Write-Output"))
  for (const use of [display + " > log.txt", "$file = " + display, display + " | Get-Item", display.replace("Write-Output", "Get-Item")]) {
    expect((await analyzeShellCommand(use, "powershell")).paths, use).toContain("\\r")
  }
})
