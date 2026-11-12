import { describe, expect } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import { Effect } from "effect"
import { AppProcess } from "@zaovra-ai/core/process"
import { LayerNode } from "@zaovra-ai/core/effect/layer-node"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(AppProcess.node))

describe.skipIf(process.platform !== "win32")("Windows long commands", () => {
  const scripts = async () =>
    (await fs.readdir(os.tmpdir())).filter((name) => name.startsWith("zaovra-shell-")).toSorted()
  // Windows caps one command line at 32,767 characters; models routinely inline whole scripts.
  const filler = Array.from({ length: 700 }, (_, index) => `$null = '填充行 ${index} ${"x".repeat(30)}'`).join("\n")

  it.live(
    "runs a PowerShell command longer than the command-line limit and removes its script file",
    Effect.gen(function* () {
      const service = yield* AppProcess.Service
      const before = yield* Effect.promise(scripts)
      const command = `${filler}\nWrite-Output 'LONG_COMMAND_SENTINEL_中文'`
      expect(Buffer.byteLength(command)).toBeGreaterThan(30_000)
      const result = yield* service.run(AppProcess.shellCommand(command, process.cwd(), "powershell.exe"))
      expect(result.exitCode).toBe(0)
      expect(result.stdout.toString()).toContain("LONG_COMMAND_SENTINEL_中文")
      expect(yield* Effect.promise(scripts)).toEqual(before)
    }),
    30000,
  )

  it.live(
    "keeps exit codes and structured failure reasons for long PowerShell commands",
    Effect.gen(function* () {
      const service = yield* AppProcess.Service
      const exit = yield* service.run(AppProcess.shellCommand(`${filler}\nexit 7`, process.cwd(), "powershell.exe"))
      expect(exit.exitCode).toBe(7)
      const syntax = yield* service.run(AppProcess.shellCommand(`${filler}\nif (`, process.cwd(), "powershell.exe"), {
        combineOutput: true,
      })
      expect(syntax.reason).toBe("syntax-incompatible")
      const missing = yield* service.run(
        AppProcess.shellCommand(`${filler}\nzaovra_nonexistent_executable_long`, process.cwd(), "powershell.exe"),
        { combineOutput: true },
      )
      expect(missing.reason).toBe("command-not-found")
    }),
    30000,
  )

  it.live(
    "keeps short PowerShell commands inline without touching the temp directory",
    Effect.gen(function* () {
      const before = yield* Effect.promise(scripts)
      AppProcess.shellCommand("Write-Output 'short'", process.cwd(), "powershell.exe")
      expect(yield* Effect.promise(scripts)).toEqual(before)
    }),
  )
})
