import { expect, test } from "bun:test"
import { analyzeCommand } from "../src/tool/bash-preflight"
import { archiveInspection } from "./fixture/powershell-archive"

test("550 screenshot archive inspection binds every derived value to one literal file", () => {
  const file = "D:\\工作电脑\\MCN\\国内社媒AI博主list-麻酱.xlsx"
  for (const command of [archiveInspection(file), archiveInspection(file).replaceAll("\n", "; ")])
    expect(analyzeCommand(command, "powershell")).toEqual({ paths: [file], uncertain: true, externalRisk: false })
})

test("550 constant PowerShell bindings expose canonical operands without unresolved expansion", () => {
  for (const command of [
    "$p='data/file.txt'; Get-Content $p",
    '$p="data/file.txt"; Get-Content "$p"',
    "$limit=10; Write-Output $limit",
    "$p='data'; Set-Location $p",
  ]) {
    expect(analyzeCommand(command, "powershell").externalRisk, command).toBe(false)
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

test("550 archive recognition cannot hide added effects, different APIs, rebinding or identity aliases", () => {
  const base = archiveInspection("input.xlsx")
  for (const command of [
    base + "\nGet-Content $env:HOME",
    base.replace("::OpenRead", "::Open"),
    base.replace("$z.Dispose()", "$z.ExtractToDirectory($env:TEMP)"),
    base.replace("$z.Entries | Select", "$z=Get-Content path.txt; $z.Entries | Select"),
    base.replaceAll("$e", "$z"),
    base.replace("System.IO.Compression.FileSystem", "evil.dll"),
  ]) {
    expect(analyzeCommand(command, "powershell").externalRisk).toBe(true)
  }
  expect(analyzeCommand(archiveInspection("../outside/input.xlsx"), "powershell").paths).toEqual([
    "../outside/input.xlsx",
  ])
})
