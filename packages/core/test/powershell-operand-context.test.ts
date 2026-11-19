import { expect, test } from "bun:test"
import { analyzeShellCommand } from "../src/tool/bash-preflight"

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
