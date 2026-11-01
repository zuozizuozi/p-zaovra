import { expect, test } from "bun:test"
import { analyzeCommand } from "../src/tool/bash-preflight"

test("502 preflight includes plain relative and flag operands without treating switches as files", () => {
  for (const shell of ["cmd", "powershell", "posix"] as const) {
    expect(
      analyzeCommand('cat sub/file.txt linked/file --file=sub/../../outside.txt bare.txt "a b.txt" -q', shell).paths,
    ).toEqual(["sub/file.txt", "linked/file", "sub/../../outside.txt", "bare.txt", "a b.txt"])
    expect(analyzeCommand('cat --file="sub/file.txt"', shell).paths).toEqual(["sub/file.txt"])
  }
})

test("490 preflight finds literal parent operands and treats unsupported syntax as uncertain", () => {
  expect(analyzeCommand('cat "../outside/a b.txt"', "posix")).toEqual({
    paths: ["../outside/a b.txt"],
    uncertain: false,
  })
  expect(analyzeCommand("printf 'literal*'", "posix")).toEqual({ paths: [], uncertain: false })
  for (const command of [
    "echo $HOME",
    "cat ~/outside",
    ". ./script.sh",
    "echo x; echo y",
    "echo x && echo y",
    "cat *.txt",
    "cat < ../outside/a",
    "cd ../outside && cat a",
    "sh -c 'cat a'",
    "python -c 'print(1)'",
    "cat /tmp/a\\ b",
    'echo "unfinished',
  ]) {
    expect(analyzeCommand(command, "posix").uncertain).toBe(true)
  }
  expect(analyzeCommand("echo %TEMP%", "cmd").uncertain).toBe(true)
  expect(analyzeCommand("echo !DYNAMIC!", "cmd").uncertain).toBe(true)
  expect(analyzeCommand('Get-Content "$env:HOME/file"', "powershell").uncertain).toBe(true)
  expect(analyzeCommand("Get-Item HKLM:\\SOFTWARE", "powershell").uncertain).toBe(true)
  const many = analyzeCommand(Array.from({ length: 257 }, (_, index) => `../outside/${index}`).join(" "), "posix")
  expect(many.uncertain).toBe(true)
  expect(many.paths).toHaveLength(256)
})
