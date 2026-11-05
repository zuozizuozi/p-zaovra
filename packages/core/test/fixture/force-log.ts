import { writeFileSync } from "node:fs"
import path from "node:path"
import { scheduler } from "node:timers/promises"
import { NodeFileSystem } from "@effect/platform-node"
import { Effect, Layer, Logger, References } from "effect"
import { Logging } from "../../src/observability/logging"
import { ProcessTree } from "../../src/process-tree"
import { Global } from "../../src/global"

const directory = process.argv[2]
const mode = process.argv[3]
const signal = mode.includes("int") ? "SIGINT" : "SIGTERM"
setTimeout(() => process.exit(97), 10000).unref()
ProcessTree.installSignalHandlers()
ProcessTree.events.on("cleanup", (cleanup) => {
  writeFileSync(path.join(directory, "cleanup.json"), JSON.stringify({ ...cleanup, at: Date.now() }))
})
process.on("exit", () => writeFileSync(path.join(directory, "exit.json"), JSON.stringify({ at: Date.now() })))
if (mode.includes("hang")) ProcessTree.onForceExit(() => new Promise(() => {}))
if (mode.includes("reject")) ProcessTree.onForceExit(() => Promise.reject(new Error("synthetic logger drain failure")))
if (mode.includes("removed")) {
  const remove = ProcessTree.onForceExit(() => Promise.reject(new Error("removed drain must not run")))
  remove()
  remove()
}
writeFileSync(path.join(directory, "log-path.json"), JSON.stringify(path.join(Global.Path.log, "zaovra.log")))
const layer = Logging.processTreeEvents.pipe(
  Layer.provide(
    Logger.layer(Logging.loggers(), { mergeWithExisting: false }).pipe(Layer.provide(NodeFileSystem.layer)),
  ),
  Layer.provideMerge(Layer.succeed(References.MinimumLogLevel, mode.includes("warn") ? "Warn" : "Info")),
)
await Effect.runPromise(
  Effect.promise(async () => {
    const tool = await ProcessTree.start(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" })
    writeFileSync(path.join(directory, "tool.json"), JSON.stringify({ pid: tool.pid }))
    process.stdout.write("payload")
    process.emit(signal)
    if (mode.includes("repeat")) process.emit(signal)
    await scheduler.wait(1500)
  }).pipe(Effect.provide(layer)),
)
process.exit(ProcessTree.signalExitCode() ?? 0)
