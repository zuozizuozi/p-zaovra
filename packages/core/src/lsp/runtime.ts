export * as LSPRuntime from "./runtime"

import { Effect } from "effect"
import { ChildProcess } from "effect/unstable/process"
import launch from "cross-spawn"
import path from "path"
import { createWriteStream } from "fs"
import { Readable } from "stream"
import { pipeline } from "stream/promises"
import { FSUtil } from "../fs-util"
import { AppProcess } from "../process"
import { LSPBuiltins } from "./builtins"
import type { ChildProcessWithoutNullStreams } from "child_process"

export const make = Effect.fn("LSPRuntime.make")(function* () {
  const fs = yield* FSUtil.Service
  const processService = yield* AppProcess.Service
  const children = new Set<ReturnType<typeof launch>>()
  const controller = new AbortController()
  yield* Effect.addFinalizer(() =>
    Effect.forEach(
      children,
      (child) =>
        Effect.gen(function* () {
          if (child.exitCode !== null || child.signalCode !== null) return
          if (process.platform === "win32" && child.pid) {
            const stopped = yield* processService
              .run(ChildProcess.make("taskkill", ["/pid", String(child.pid), "/T", "/F"]))
              .pipe(
                Effect.map((result) => result.exitCode === 0),
                Effect.catch(() => Effect.succeed(false)),
              )
            if (stopped) return
          }
          child.kill()
        }),
      { discard: true },
    ),
  )
  yield* Effect.addFinalizer(() => Effect.sync(() => controller.abort()))
  const spawn: LSPBuiltins.Runtime["process"]["spawn"] = (command, options) => {
    controller.signal.throwIfAborted()
    if (!command.length) throw new Error("Language server command is empty")
    const child = launch(command[0]!, command.slice(1), {
      cwd: options?.cwd,
      env: { ...process.env, ...options?.env },
      stdio: [options?.stdin ?? "ignore", options?.stdout ?? "ignore", options?.stderr ?? "ignore"],
      windowsHide: true,
    })
    children.add(child)
    child.once("close", () => children.delete(child))
    const exited = new Promise<number>((resolve, reject) => {
      child.once("exit", (code) => resolve(code ?? 1))
      child.once("error", reject)
    })
    void exited.catch(() => undefined)
    return Object.assign(child, { exited })
  }
  const run: LSPBuiltins.Runtime["process"]["run"] = async (command, options) => {
    const result = await Effect.runPromise(
      processService.run(
        ChildProcess.make(command[0]!, command.slice(1), { cwd: options?.cwd, env: options?.env, extendEnv: true }),
        { timeout: "5 minutes", signal: controller.signal },
      ),
    )
    if (result.exitCode !== 0 && !options?.nothrow)
      throw new Error(`Language server setup failed (exit ${result.exitCode})`)
    return { code: result.exitCode, stdout: result.stdout, stderr: result.stderr }
  }
  const runtime: LSPBuiltins.Runtime = {
    filesystem: {
      async *up(options) {
        yield* await Effect.runPromise(fs.up(options))
      },
      findUp: (target, start, stop) => Effect.runPromise(fs.findUp(target, start, stop)),
      exists: (file) => Effect.runPromise(fs.existsSafe(file)),
      readText: (file) => Effect.runPromise(fs.readFileString(file)),
      write: (file, content) => Effect.runPromise(fs.writeWithDirs(file, content)),
      async writeStream(file, stream) {
        await Effect.runPromise(fs.ensureDir(path.dirname(file)))
        const reader = stream.getReader()
        await pipeline(
          Readable.from(
            (async function* () {
              try {
                while (true) {
                  const chunk = await reader.read()
                  if (chunk.done) return
                  yield chunk.value
                }
              } finally {
                await reader.cancel().catch(() => undefined)
                reader.releaseLock()
              }
            })(),
          ),
          createWriteStream(file),
          { signal: controller.signal },
        )
      },
    },
    process: {
      run,
      async text(command, options) {
        const result = await run(command, options)
        return { ...result, text: result.stdout.toString() }
      },
      spawn(command, options) {
        const child = spawn(command, options)
        // Installers are awaited by exit status, so their output must not fill a pipe.
        child.stdout?.resume()
        child.stderr?.resume()
        return child
      },
    },
    archive: {
      async extractZip(file, destination) {
        if (process.platform !== "win32") {
          await run(["unzip", "-o", "-q", file, "-d", destination])
          return
        }
        await run(
          [
            "powershell",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; Expand-Archive -LiteralPath $env:ZAOVRA_LSP_ARCHIVE -DestinationPath $env:ZAOVRA_LSP_DESTINATION -Force",
          ],
          {
            env: { ZAOVRA_LSP_ARCHIVE: path.resolve(file), ZAOVRA_LSP_DESTINATION: path.resolve(destination) },
          },
        )
      },
    },
    spawn(command, argsOrOptions?: string[] | Parameters<typeof spawn>[1], options?: Parameters<typeof spawn>[1]) {
      const child = spawn([command, ...(Array.isArray(argsOrOptions) ? argsOrOptions : [])], {
        ...(Array.isArray(argsOrOptions) ? options : argsOrOptions),
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      })
      if (!child.stdin || !child.stdout || !child.stderr) throw new Error("Language server streams are unavailable")
      return child as ChildProcessWithoutNullStreams & { exited: Promise<number> }
    },
  }
  return runtime
})
