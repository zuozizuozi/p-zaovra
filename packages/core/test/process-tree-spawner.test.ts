import { describe, expect } from "bun:test"
import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { scheduler } from "node:timers/promises"
import { Effect } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { CrossSpawnSpawner } from "@zaovra-ai/core/cross-spawn-spawner"
import { LayerNode } from "@zaovra-ai/core/effect/layer-node"
import { ProcessTree } from "@zaovra-ai/core/process-tree"
import { ProcessTreeNative } from "#process-tree-native"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(CrossSpawnSpawner.node))

async function ready(file: string) {
  const deadline = Date.now() + 10_000
  for (;;) {
    const value = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return
      throw error
    })
    if (value) return JSON.parse(value) as { pid: number; child?: number }
    if (Date.now() >= deadline) throw new Error(`Tool readiness deadline exceeded: ${file}`)
    await scheduler.wait(10)
  }
}

describe("spawner owned-tree scope disposal", () => {
  if (!ProcessTree.supported()) return
  it.live(
    "waits for detached tool descendants while leaving an unrelated process alive",
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(path.join(tmpdir(), "zaovra-tree-scope-"))),
        (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
      )
      const unrelated = yield* Effect.acquireRelease(
        Effect.promise(async () => {
          const child = spawn(
            process.execPath,
            ["-e", "setTimeout(()=>process.exit(0),120000);setInterval(()=>{},60000)"],
            { stdio: "ignore" },
          )
          const identity = await ProcessTreeNative.identity(child.pid!)
          if (!identity) throw new Error("Unrelated fixture identity is unavailable")
          return identity
        }),
        (identity) => Effect.promise(() => ProcessTreeNative.signal(identity, "SIGKILL")),
      )
      const childCode = `require('node:fs').writeFileSync(${JSON.stringify(path.join(directory, "child.json"))},JSON.stringify({pid:process.pid}));setTimeout(()=>process.exit(0),120000);setInterval(()=>{},60000)`
      const toolCode = `const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{detached:true,stdio:'ignore'});require('node:fs').writeFileSync(${JSON.stringify(path.join(directory, "root.json"))},JSON.stringify({pid:process.pid,child:child.pid}));setTimeout(()=>process.exit(0),120000);setInterval(()=>{},60000)`
      const pids = yield* Effect.scoped(
        Effect.gen(function* () {
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
          const handle = yield* spawner.spawn(
            ChildProcess.make(process.execPath, ["-e", toolCode], { stdin: "ignore" }),
          )
          const root = yield* Effect.promise(() => ready(path.join(directory, "root.json")))
          const child = yield* Effect.promise(() => ready(path.join(directory, "child.json")))
          expect(root.pid).toBe(Number(handle.pid))
          expect(root.child).toBe(child.pid)
          return [root.pid, child.pid]
        }),
      )
      for (const pid of pids) expect(yield* Effect.promise(() => ProcessTreeNative.identity(pid))).toBeUndefined()
      expect((yield* Effect.promise(() => ProcessTreeNative.identity(unrelated.pid)))?.birth).toBe(unrelated.birth)
    }),
    60_000,
  )
})
