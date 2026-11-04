import { writeFile, readFile } from "node:fs/promises"
import path from "node:path"
import { scheduler } from "node:timers/promises"
import { Effect } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { LayerNode } from "@zaovra-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@zaovra-ai/core/cross-spawn-spawner"
import { ProcessTree } from "@zaovra-ai/core/process-tree"

const directory = process.argv[2]
const leaf = `require('node:fs').writeFileSync(${JSON.stringify(path.join(directory, "leaf.json"))},JSON.stringify({pid:process.pid}));setTimeout(()=>process.exit(0),15000);setInterval(()=>{},60000)`
const tool = `const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(leaf)}],{detached:true,stdio:'ignore'});require('node:fs').writeFileSync(${JSON.stringify(path.join(directory, "tool.json"))},JSON.stringify({pid:process.pid,child:c.pid}));setTimeout(()=>process.exit(0),15000);setInterval(()=>{},60000)`

ProcessTree.installSignalHandlers()
try {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const handle = yield* spawner.spawn(ChildProcess.make(process.execPath, ["-e", tool], { stdin: "ignore" }))
        yield* Effect.promise(async () => {
          const deadline = Date.now() + 10_000
          while (!(await readFile(path.join(directory, "leaf.json"), "utf8").catch(() => undefined))) {
            if (Date.now() >= deadline) throw new Error("Detached tool did not start")
            await scheduler.wait(10)
          }
          await writeFile(path.join(directory, "cli.json"), JSON.stringify({ pid: process.pid, tool: handle.pid }))
        })
        yield* handle.exitCode
      }),
    ).pipe(
      Effect.onInterrupt(() => Effect.promise(() => writeFile(path.join(directory, "interrupted"), "interrupted"))),
      Effect.provide(LayerNode.compile(CrossSpawnSpawner.node)),
    ),
    { signal: ProcessTree.shutdownSignal },
  )
} finally {
  await ProcessTree.shutdown()
}
