import { expect, test } from "bun:test"
import path from "node:path"
import { analyzeCommand } from "../src/tool/bash-preflight"
import { powerShellLiteralOperands } from "../src/tool/powershell-paths"
import { powerShellVariants } from "./fixture/powershell-variants"

test("562 common forms expose literal paths without command-specific recognition", () => {
  const file = "D:\\示例项目\\资料\\示例清单.xlsx"
  for (const [index, command] of powerShellVariants(file).entries()) {
    expect(powerShellLiteralOperands(command).paths, command).toContain(index === 2 ? path.dirname(file) : file)
    expect(analyzeCommand(command, "powershell").literalScanComplete).toBe(true)
  }
})

test("550 constant PowerShell bindings expose canonical operands without unresolved expansion", () => {
  for (const command of [
    "$p='data/file.txt'; Get-Content $p",
    '$p="data/file.txt"; Get-Content "$p"',
    "$limit=10; Write-Output $limit",
    "$p='data'; Set-Location $p",
  ]) {
    expect(analyzeCommand(command, "powershell").literalScanComplete, command).toBe(true)
  }
  expect(analyzeCommand("$p='../outside/file.txt'; Get-Content $p", "powershell").paths).toContain(
    "../outside/file.txt",
  )
})

test("550 unknown assignments, mutators, scopes and script evaluation retain confirmation", () => {
  for (const command of [
    "Get-Content $unknown",
    "$p=$env:HOME; Get-Content $p",
    "$p='safe'; sv p (Get-Content path.txt); Get-Content $p",
    "$p='safe'; Set-Variable p '../outside'; Get-Content $p",
    "$p='safe'; $p += '/suffix'; Get-Content $p",
    "$p='safe'; Invoke-Expression $p",
    "$p='safe'; & $p",
    "$p='safe'; . ./script.ps1; Get-Content $p",
    '$p="safe"; Get-Content $p "',
  ]) {
    expect(analyzeCommand(command, "powershell").externalRisk).toBe(true)
  }
})

test("562 external literal prefixes and incomplete scans remain observable", () => {
  for (const command of [
    "$renamed='../outside/file.txt'; [IO.File]::ReadAllText($renamed)",
    "Import-Csv -LiteralPath '../outside/file.csv'",
    "Get-ChildItem '../outside/*.txt'",
    'Get-Content "../outside/$name"',
  ]) {
    expect(
      powerShellLiteralOperands(command).paths.some((value) => value.startsWith("../outside")),
      command,
    ).toBe(true)
  }
  expect(powerShellLiteralOperands("$p='../outside/it''s.txt'; Get-Content $p").paths).toContain("../outside/it's.txt")
  expect(powerShellLiteralOperands('Get-Item --file="sub/file.txt"').paths).toEqual(["sub/file.txt"])
  expect(powerShellLiteralOperands("../outside/tool.exe -q").paths).toContain("../outside/tool.exe")
  for (const command of [
    'Get-Content "unfinished',
    "x".repeat(16_385),
    Array.from({ length: 258 }, (_, i) => `file${i}`).join(" "),
  ]) {
    expect(analyzeCommand(command, "powershell").literalScanComplete).toBe(false)
    expect(analyzeCommand(command, "powershell").externalRisk).toBe(true)
  }
})
