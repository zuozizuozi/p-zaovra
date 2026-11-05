import { writeFileSync } from "node:fs"
import path from "node:path"
import { scheduler } from "node:timers/promises"
import { Effect } from "effect"
import { ProcessTree } from "@zaovra-ai/core/process-tree"
import { effectCmd, fail } from "../../../src/cli/effect-cmd"
import { AppRuntime } from "../../../src/effect/app-runtime"
import { registerDisposer } from "../../../src/effect/instance-registry"

const directory = process.argv[2]
const mode = process.argv[3]
const events: string[] = []
const event = async (name: string) => {
  events.push(name)
  writeFileSync(path.join(directory, "events.json"), JSON.stringify(events))
}
const keepalive = setInterval(() => {}, 1000)
setTimeout(() => process.exit(97), 20000).unref()
ProcessTree.installSignalHandlers()
const unregister = registerDisposer(async (current) => {
  if (path.resolve(current) !== path.resolve(directory)) return
  await event("dispose-started")
  await scheduler.wait(200)
  await event("dispose-completed")
})
const command = effectCmd({
  command: "fixture",
  describe: false,
  directory: () => directory,
  handler: () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => event("handler-ready"))
      if (mode === "normal") return
      if (mode === "error") return yield* fail("fixture failure")
      if (mode.startsWith("event-"))
        setTimeout(() => {
          process.emit(mode === "event-int" ? "SIGINT" : "SIGTERM")
          if (mode === "event-repeat") {
            process.emit("SIGTERM")
            process.emit("SIGINT")
          }
        }, 10)
      yield* Effect.never.pipe(Effect.onInterrupt(() => Effect.promise(() => event("handler-interrupted"))))
    }),
})
try {
  if (typeof command.handler !== "function") throw new Error("No command handler")
  await command.handler({ _: [], $0: "fixture" })
} catch {
  if (ProcessTree.signalExitCode?.() === undefined) {
    await event("command-error")
    process.exitCode = 1
  }
} finally {
  await ProcessTree.shutdown()
  unregister()
  await AppRuntime.dispose()
  await event("top-finally-completed")
  clearInterval(keepalive)
  if (process.exitCode !== 1) process.exitCode = ProcessTree.signalExitCode?.()
}
process.exit()
