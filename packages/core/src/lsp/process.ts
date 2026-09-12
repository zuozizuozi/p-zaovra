export * as LSPProcess from "./process"

import { Effect } from "effect"
import { ChildProcess } from "effect/unstable/process"
import launch from "cross-spawn"
import path from "path"
import { realpathSync } from "fs"
import { FSUtil } from "../fs-util"
import { AppProcess } from "../process"
import { LSPClient } from "./client"
import type { ChildProcessWithoutNullStreams } from "child_process"
import { LSPBuiltins } from "./builtins"

export const open = Effect.fn("LSPProcess.open")(function* (input: {
  serverID: string
  command?: readonly string[]
  server?: LSPBuiltins.Handle
  root: string
  directory: string
  environment?: Record<string, string>
  initialization?: Record<string, unknown>
}) {
  const fs = yield* FSUtil.Service
  const processService = yield* AppProcess.Service
  if (!input.server && !input.command?.length) return yield* Effect.fail(new Error("Language server command is empty"))
  const child = yield* Effect.acquireRelease(
    input.server
      ? Effect.succeed(input.server.process)
      : Effect.tryPromise(
          () =>
            new Promise<ReturnType<typeof launch>>((resolve, reject) => {
              const child = launch(input.command![0]!, input.command!.slice(1), {
                cwd: input.root,
                env: { ...process.env, ...input.environment },
                stdio: "pipe",
                windowsHide: true,
              })
              child.once("spawn", () => resolve(child))
              child.once("error", reject)
            }),
        ),
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
  )
  if (!child.stdin || !child.stdout || !child.stderr)
    return yield* Effect.fail(new Error("Language server streams are unavailable"))
  const client = yield* Effect.tryPromise(() =>
    LSPClient.create({
      serverID: input.serverID,
      server: {
        process: child as ChildProcessWithoutNullStreams,
        initialization: input.initialization ?? input.server?.initialization,
      },
      root: input.root,
      directory: input.directory,
      runtime: {
        normalizePath: (file) => {
          if (process.platform !== "win32") return file
          const resolved = path.resolve(file)
          try {
            return realpathSync.native(resolved)
          } catch {
            return resolved
          }
        },
        readText: (file) => Effect.runPromise(fs.readFileString(file)),
        // The outer scoped process owner also handles initialization failures.
        stop: async () => {},
      },
    }),
  )
  yield* Effect.addFinalizer(() => Effect.promise(() => client.shutdown()))
  return client
})
