import { describe, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { Effect, Exit } from "effect"
import { AppProcess } from "@zaovra-ai/core/process"
import { LayerNode } from "@zaovra-ai/core/effect/layer-node"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(AppProcess.node))

describe.skipIf(process.platform !== "win32")("Windows shell boundary", () => {
  it.live(
    "preserves PowerShell quotes, Unicode paths, multiline scripts and native exit codes",
    Effect.acquireUseRelease(
      Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "zaovra shell 中文 "))),
      (directory) =>
        Effect.gen(function* () {
          const processService = yield* AppProcess.Service
          const command =
            "Set-Content -LiteralPath 'a b.txt' -Value 'value with \"quotes\"'\nGet-Content -LiteralPath 'a b.txt'\n(Get-Location).Path"
          const result = yield* processService.run(AppProcess.shellCommand(command, directory, "powershell.exe"))
          expect(result.exitCode).toBe(0)
          expect(result.stdout.toString("utf8")).toContain('value with "quotes"')
          expect(result.stdout.toString("utf8")).toContain("中文")
          const failed = yield* processService.run(
            AppProcess.shellCommand("cmd.exe /d /c exit 7", directory, "powershell.exe"),
          )
          expect(failed.exitCode).toBe(7)
          const cmd = yield* processService.run(AppProcess.shellCommand('type "a b.txt"', directory, "cmd.exe"))
          expect(cmd.exitCode).toBe(0)
          expect(cmd.stdout.toString()).toContain('value with "quotes"')
        }),
      (directory) => Effect.promise(() => fs.rm(directory, { recursive: true, force: true })),
    ),
    15000,
  )

  it.live(
    "timeout kills the shell and its child process",
    Effect.acquireUseRelease(
      Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "zaovra-tree-"))),
      (directory) =>
        Effect.gen(function* () {
          const processService = yield* AppProcess.Service
          yield* Effect.promise(() =>
            fs.writeFile(
              path.join(directory, "child.cjs"),
              'require("fs").writeFileSync("pid",String(process.pid));setInterval(()=>{},1000)',
            ),
          )
          const executable = process.execPath.replaceAll("'", "''")
          const exit = yield* Effect.exit(
            processService.run(AppProcess.shellCommand(`& '${executable}' 'child.cjs'`, directory, "powershell.exe"), {
              timeout: "3 seconds",
            }),
          )
          expect(Exit.isFailure(exit)).toBe(true)
          const pid = Number(yield* Effect.promise(() => fs.readFile(path.join(directory, "pid"), "utf8")))
          expect(Number.isInteger(pid) && pid > 0).toBe(true)
          expect(() => process.kill(pid, 0)).toThrow()
        }),
      (directory) => Effect.promise(() => fs.rm(directory, { recursive: true, force: true })),
    ),
    15000,
  )
})
