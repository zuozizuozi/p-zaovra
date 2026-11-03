import { expect, test } from "bun:test"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { analyzeCommand } from "../src/tool/bash-preflight"
import { powerShellLiteralOperands } from "../src/tool/powershell-paths"

test("566 file URI operands expose external Windows targets through casts and constructors", () => {
  for (const command of [
    '[IO.File]::ReadAllText(([Uri]"file:///C:/outside/private.txt").LocalPath)',
    "$u=New-Object Uri 'file:///C:/outside/private.txt'; Get-Content $u.LocalPath",
    "$u=[System.Uri]::new('file:///C:/outside/private.txt'); Get-Content $u.LocalPath",
  ]) {
    expect(powerShellLiteralOperands(command).paths, command).toContain("C:\\outside\\private.txt")
    expect(analyzeCommand(command, "powershell").literalScanComplete).toBe(true)
  }
  expect(powerShellLiteralOperands("Get-Item 'file:///C:/outside/a%20b.txt'").paths).toContain("C:\\outside\\a b.txt")
  expect(powerShellLiteralOperands("Get-Item 'file:///C:/outside/%E8%B5%84%E6%96%99.txt'").paths).toContain(
    "C:\\outside\\资料.txt",
  )
  expect(powerShellLiteralOperands("Get-Item 'file://server/share/private.txt'").paths).toContain(
    "\\\\server\\share\\private.txt",
  )
  expect(powerShellLiteralOperands("Get-Item 'file://xn--fiq228c.com/share/private.txt'").paths).toContain(
    "\\\\中文.com\\share\\private.txt",
  )
})

test("566 UNC and extended Windows path prefixes survive the scan without wildcard truncation", () => {
  for (const [input, expected] of [
    [String.raw`\\server\share\private.txt`, String.raw`\\server\share\private.txt`],
    [String.raw`\\?\C:\outside\private.txt`, String.raw`C:\outside\private.txt`],
    ["//?/C:/outside/private.txt", String.raw`C:\outside\private.txt`],
    [String.raw`\\?\UNC\server\share\private.txt`, String.raw`\\server\share\private.txt`],
  ]) {
    const result = powerShellLiteralOperands(`Get-Content '${input}'`)
    expect(result.paths, input).toContain(expected)
    expect(result.complete).toBe(true)
    expect(result.paths).not.toContain("\\\\")
  }
})

test("566 malformed file URIs and unsupported device prefixes keep the scan incomplete", () => {
  for (const input of [
    "file:///%ZZ",
    "file:///C:/%ZZ",
    "file:///C:/outside/a%2Fb",
    "file:///C:/outside/a%5Cb",
    "file:///C:/outside/a%00b",
    "file://user:pass@server/share",
    "file:relative.txt",
    "file:///C:/outside/a?query=1",
    String.raw`\\?\GLOBALROOT\Device\HarddiskVolume1\private.txt`,
  ]) {
    const result = analyzeCommand(`Get-Content '${input}'`, "powershell")
    expect(result.literalScanComplete, input).toBe(false)
    expect(result.externalRisk, input).toBe(true)
  }
})

test("567 native file URI strictly decodes spaces and Unicode on the current host", () => {
  const file = path.resolve("fixture", "资料 a.txt")
  const uri = pathToFileURL(file).href
  const scan = powerShellLiteralOperands(`Get-Content '${uri}'`)
  expect(scan.paths).toContain(file)
  expect(scan.complete).toBe(true)
})
