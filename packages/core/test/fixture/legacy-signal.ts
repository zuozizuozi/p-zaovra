import { writeFileSync, readFileSync, existsSync } from "node:fs"
import path from "node:path"
import { scheduler } from "node:timers/promises"
import { Effect } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { LayerNode } from "../../src/effect/layer-node"
import { AppProcess } from "../../src/process"
import { ProcessTree } from "../../src/process-tree"

const directory = process.argv[2]
const mode = process.argv[3]
const events: { name: string; at: number; pid?: number }[] = []
const event = (name: string, pid?: number) => {
  events.push({ name, at: Date.now(), pid })
  writeFileSync(path.join(directory, "events.json"), JSON.stringify(events))
}
const signal = mode.includes("int") ? "SIGINT" : "SIGTERM"
const normal = mode.includes("normal")
const external = mode.includes("external")
const ready = path.join(directory, "child.json")
const signalWhenReady = async () => {
  const until = Date.now() + 10000
  while ((mode.startsWith("app") || mode.startsWith("owned")) && !existsSync(ready)) {
    if (Date.now() >= until) throw new Error("Work did not start")
    await scheduler.wait(10)
  }
  event(
    "work-ready",
    mode.startsWith("app") || mode.startsWith("owned") ? JSON.parse(readFileSync(ready, "utf8")).pid : undefined,
  )
  if (normal || external) return
  await scheduler.wait(80)
  event("signal-sent")
  process.emit(signal)
  if (mode.includes("repeat")) {
    if (mode.startsWith("owned")) {
      const until = Date.now() + 5000
      while (!existsSync(path.join(directory, "term-seen"))) {
        if (Date.now() >= until) throw new Error("Owned tool did not enter termination grace")
        await scheduler.wait(5)
      }
    }
    event("second-signal")
    process.emit("SIGINT")
  }
}
setTimeout(() => process.exit(97), 15000).unref()
process.on("exit", () => event("process-exit"))
ProcessTree.events.on("force", () => event("force-started"))
ProcessTree.installSignalHandlers()
try {
  if (mode.startsWith("owned")) {
    const script =
      'const fs=require("node:fs");fs.writeFileSync(' +
      JSON.stringify(ready) +
      ',JSON.stringify({pid:process.pid}));process.on("SIGTERM",()=>fs.writeFileSync(' +
      JSON.stringify(path.join(directory, "term-seen")) +
      ',"seen"));setInterval(()=>{},1000);setTimeout(()=>process.exit(0),8000)'
    const tool = await ProcessTree.start(process.execPath, ["-e", script], { stdio: "ignore" })
    await ProcessTree.run(async (abort) => {
      const stopped = new Promise<void>((resolve) => abort.addEventListener("abort", () => resolve(), { once: true }))
      void signalWhenReady()
      await stopped
      event("owner-stop-started")
      await tool.owner.stop("SIGTERM", 5000)
      event("owner-stop-completed")
    })
  } else if (mode.startsWith("cooperative")) {
    await ProcessTree.run(async (abort) => {
      const stopped = new Promise<void>((resolve) => abort.addEventListener("abort", () => resolve(), { once: true }))
      void signalWhenReady()
      await stopped
      event("dispose-started")
      await scheduler.wait(700)
      event("dispose-completed")
    })
  } else if (mode.startsWith("app")) {
    const script =
      'const fs=require("node:fs");fs.writeFileSync(' +
      JSON.stringify(ready) +
      ",JSON.stringify({pid:process.pid}));setTimeout(()=>{fs.writeFileSync(" +
      JSON.stringify(path.join(directory, "work-completed.txt")) +
      ',"completed");process.stdout.write("work-completed-after-signal");process.exit(0)},700)'
    const work = Effect.runPromise(
      Effect.gen(function* () {
        const app = yield* AppProcess.Service
        return yield* app.run(ChildProcess.make(process.execPath, ["-e", script], { stdin: "ignore" }))
      }).pipe(Effect.provide(LayerNode.compile(AppProcess.node))),
    )
    await signalWhenReady()
    const result = await work
    process.stdout.write(result.stdout)
    event("work-completed")
  } else {
    void signalWhenReady()
    await scheduler.wait(700)
    process.stdout.write("work-completed-after-signal")
    event("work-completed")
  }
} catch (error) {
  if (!ProcessTree.shutdownSignal.aborted) throw error
} finally {
  await ProcessTree.shutdown()
  event("top-finally")
}
process.exit(ProcessTree.signalExitCode() ?? 0)
