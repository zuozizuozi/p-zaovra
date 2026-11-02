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
    externalRisk: false,
  })
  expect(analyzeCommand("printf 'literal*'", "posix")).toEqual({ paths: [], uncertain: false, externalRisk: false })
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

test("511 separates ordinary shell syntax from unresolved external-path risk", () => {
  for (const command of ["ls | grep x", "echo a > f", "python -c 'print(1)'", 'echo "a b"', "cd sub && ls"]) {
    expect(analyzeCommand(command, "posix").externalRisk).toBe(false)
  }
  for (const command of ["cat $HOME/f", "cat ~/f", "cat ../outside/*.txt", "cat *.txt", 'echo "unfinished']) {
    expect(analyzeCommand(command, "posix").externalRisk).toBe(true)
  }
  expect(analyzeCommand("cat %TEMP%/f", "cmd").externalRisk).toBe(true)
  expect(analyzeCommand('Get-Content "$env:HOME/file"', "powershell").externalRisk).toBe(true)
})

test("515 changed cwd keeps later relative operands unresolved without escalating pure cd or command names", () => {
  for (const shell of ["posix", "bash", "powershell", "cmd"] as const) {
    for (const command of [
      "cd sub && cat ../../private/f",
      "pushd sub && cat ../../private/f",
      "Set-Location sub; Get-Content ../../private/f",
      "Push-Location sub; Get-Content ../../private/f",
      "Pop-Location; Get-Content ../private/f",
      "cd sub && cat file.txt",
      "cd sub && cat > output.txt",
      "cd sub && > ../../private/f",
      "cd sub && ../../private/tool",
      "cd sub && popd && cat file.txt",
      "(cd sub && cat file.txt)",
    ]) {
      expect(analyzeCommand(command, shell).externalRisk).toBe(true)
    }
    for (const command of ["cd sub", "cd sub && make", "cd sub && ls", 'echo "cd sub && cat f"']) {
      expect(analyzeCommand(command, shell).externalRisk).toBe(false)
    }
  }
  expect(analyzeCommand("echo 'cd sub && cat f'", "cmd").externalRisk).toBe(true)
  expect(analyzeCommand("sl sub; Get-Content ../private/f", "powershell").externalRisk).toBe(true)
})

test("519 repeated directory commands retain unresolved relative target risk", () => {
  for (const shell of ["posix", "bash", "powershell", "cmd"] as const) {
    for (const command of [
      "cd sub && cd ../../private && ls",
      "pushd sub && pushd ../../private && ls",
      "Set-Location sub; Set-Location ../../private; Get-ChildItem",
      "Push-Location sub; Push-Location ../../private; Get-ChildItem",
      "popd && cd sub && ls",
      "pushd sub && popd && cd sub && ls",
      "Pop-Location; Set-Location sub; Get-ChildItem",
      "Push-Location sub; Pop-Location; Set-Location sub; Get-ChildItem",
    ]) {
      expect(analyzeCommand(command, shell).externalRisk).toBe(true)
    }
    for (const command of ["cd sub", "cd sub && make"]) {
      expect(analyzeCommand(command, shell).externalRisk).toBe(false)
    }
  }
})

test("522 previous-directory and stack references remain unresolved targets", () => {
  for (const shell of ["posix", "bash", "powershell"] as const) {
    for (const command of [
      "cd -",
      "cd -- -",
      "cd '-' && pwd",
      "builtin cd -- -",
      "pushd +1",
      "pushd -1",
      "popd +1",
      "popd -1",
      "Set-Location -",
      "Set-Location -- -",
      "Push-Location -",
      "chdir -",
    ]) {
      expect(analyzeCommand(command, shell).externalRisk).toBe(true)
    }
    for (const command of ["cd sub", "cd sub && make", "cd +1", "echo -", "echo +1", "echo 'cd -'"]) {
      expect(analyzeCommand(command, shell).externalRisk).toBe(false)
    }
  }
  expect(analyzeCommand("sl -", "powershell").externalRisk).toBe(true)
  expect(analyzeCommand("cd -", "cmd").externalRisk).toBe(false)
})
