import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { scheduler } from "node:timers/promises"
import { Effect } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { CrossSpawnSpawner } from "../src/cross-spawn-spawner"
import { LayerNode } from "../src/effect/layer-node"
import { ProcessTree } from "../src/process-tree"
import { testEffect } from "./lib/effect"

async function ready(file: string) {
  const until = Date.now() + 10000
  for (;;) {
    const data = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (data) return JSON.parse(data) as { pid: number }
    if (Date.now() >= until) throw new Error("Fixture readiness timeout: " + file)
    await scheduler.wait(10)
  }
}

async function alive(pid: number) {
  if (process.platform === "linux") {
    const data = await readFile("/proc/" + pid + "/stat", "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return ""
      throw error
    })
    return !!data && !["Z", "X"].includes(data.slice(data.lastIndexOf(") ") + 2).split(" ")[0])
  }
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false
    throw error
  }
}

function idle(file: string, finish?: string) {
  return (
    'const fs=require("node:fs");fs.writeFileSync(' +
    JSON.stringify(file) +
    ',JSON.stringify({pid:process.pid}));process.on("SIGTERM",()=>{});' +
    (finish
      ? "setInterval(()=>{if(fs.existsSync(" + JSON.stringify(finish) + "))process.exit(0)},10);"
      : "setInterval(()=>{},10000);") +
    "setTimeout(()=>process.exit(0),15000)"
  )
}

function fork(script: string) {
  return (
    'const child=require("node:child_process").spawn(process.execPath,["-e",' +
    JSON.stringify(script) +
    '],{detached:true,stdio:"ignore"});child.unref();'
  )
}

test("fast exited root keeps exit zero and reports unverified without claiming its detached child", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "zaovra-cleanup-orphan-"))
  const events: ProcessTree.Cleanup[] = []
  const observe = (value: ProcessTree.Cleanup) => events.push(value)
  ProcessTree.events.on("cleanup", observe)
  const tool = await ProcessTree.start(
    process.execPath,
    ["-e", fork(idle(path.join(dir, "child"), path.join(dir, "finish")))],
    { stdio: "ignore" },
  )
  try {
    const child = await ready(path.join(dir, "child"))
    expect(await tool.closed).toEqual([0, null])
    const stopping = tool.owner.stop()
    expect(tool.owner.stop()).toBe(stopping)
    await stopping
    expect(tool.owner.cleanup).toMatchObject({ pid: tool.pid, status: "unverified", observedExited: 0 })
    expect(events.filter((value) => value.pid === tool.pid)).toEqual([tool.owner.cleanup!])
    expect(await alive(child.pid)).toBe(true)
    console.info(
      JSON.stringify({ phase: "fast-root635", root: tool.pid, child: child.pid, exit: 0, cleanup: tool.owner.cleanup }),
    )
  } finally {
    ProcessTree.events.off("cleanup", observe)
    await writeFile(path.join(dir, "finish"), "finish")
    const child = await ready(path.join(dir, "child"))
    const until = Date.now() + 5000
    while (await alive(child.pid)) {
      if (Date.now() >= until) throw new Error("Fixture child did not close after its explicit owner protocol")
      await scheduler.wait(10)
    }
    await tool.owner.stop()
    await rm(dir, { recursive: true, force: true })
  }
}, 20000)

const it = testEffect(LayerNode.compile(CrossSpawnSpawner.node))
it.live(
  "successful short command survives its real spawner scope with separate cleanup event",
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const events: ProcessTree.Cleanup[] = []
    const observe = (value: ProcessTree.Cleanup) => events.push(value)
    yield* Effect.acquireRelease(
      Effect.sync(() => ProcessTree.events.on("cleanup", observe)),
      () => Effect.sync(() => ProcessTree.events.off("cleanup", observe)),
    )
    const result = yield* Effect.scoped(
      Effect.gen(function* () {
        const child = yield* spawner.spawn(
          ChildProcess.make(process.execPath, ["-e", "process.exitCode=0"], {
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
          }),
        )
        return { pid: Number(child.pid), exit: Number(yield* child.exitCode) }
      }),
    )
    expect(result.exit).toBe(0)
    expect(events.filter((value) => value.pid === result.pid)).toMatchObject([
      { status: "unverified", observedExited: 0 },
    ])
  }),
)

test("owned three-level targets exit while unrelated owner lives and repeated stop is idempotent", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "zaovra-cleanup-owned-"))
  const unrelated = await ProcessTree.start(process.execPath, ["-e", idle(path.join(dir, "unrelated"))], {
    stdio: "ignore",
  })
  const root = fork(fork(idle(path.join(dir, "leaf"))) + idle(path.join(dir, "middle"))) + idle(path.join(dir, "root"))
  const tool = await ProcessTree.start(process.execPath, ["-e", root], { stdio: "ignore" })
  try {
    await ready(path.join(dir, "unrelated"))
    const pids = await Promise.all(
      ["root", "middle", "leaf"].map(async (name) => (await ready(path.join(dir, name))).pid),
    )
    const stopping = tool.owner.stop("SIGTERM", 100)
    expect(tool.owner.stop()).toBe(stopping)
    await stopping
    expect(await Promise.all(pids.map(alive))).toEqual([false, false, false])
    expect(await alive(unrelated.pid)).toBe(true)
    expect(tool.owner.cleanup?.status).toBe("unverified")
    expect(tool.owner.cleanup?.observedExited).toBe(process.platform === "win32" ? 1 : 3)
    console.info(
      JSON.stringify({ phase: "owned-exited635", pids, cleanup: tool.owner.cleanup, unrelated: unrelated.pid }),
    )
  } finally {
    await tool.owner.stop()
    await unrelated.owner.stop()
    await rm(dir, { recursive: true, force: true })
  }
}, 20000)

test.skipIf(process.platform === "win32")(
  "termination snapshot reclaims a new detached child while its parent identity is still owned",
  async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "zaovra-cleanup-term-fork-"))
    const late = fork(idle(path.join(dir, "late")))
    const root = 'process.on("SIGTERM",()=>{' + late + "});" + idle(path.join(dir, "root"))
    const tool = await ProcessTree.start(process.execPath, ["-e", root], { stdio: "ignore" })
    try {
      await ready(path.join(dir, "root"))
      await tool.owner.stop("SIGTERM", 500)
      const child = await ready(path.join(dir, "late"))
      expect(await alive(child.pid)).toBe(false)
      expect(tool.owner.cleanup).toMatchObject({ status: "unverified", observedExited: 2 })
      console.info(
        JSON.stringify({ phase: "term-fork635", root: tool.pid, child: child.pid, cleanup: tool.owner.cleanup }),
      )
    } finally {
      await tool.owner.stop()
      await rm(dir, { recursive: true, force: true })
    }
  },
  20000,
)

test.skipIf(process.platform === "win32")(
  "TERM fork that loses its parent remains unverified instead of claiming the child exited",
  async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "zaovra-cleanup-term-orphan-"))
    const root =
      'process.on("SIGTERM",()=>{' +
      fork(idle(path.join(dir, "child"), path.join(dir, "finish"))) +
      "setImmediate(()=>process.exit(0));});" +
      idle(path.join(dir, "root"))
    const tool = await ProcessTree.start(process.execPath, ["-e", root], { stdio: "ignore" })
    try {
      await ready(path.join(dir, "root"))
      await tool.owner.stop("SIGTERM", 500)
      const child = await ready(path.join(dir, "child"))
      expect(await tool.closed).toEqual([0, null])
      expect(await alive(child.pid)).toBe(true)
      expect(tool.owner.cleanup).toMatchObject({ status: "unverified", observedExited: 1 })
      console.info(
        JSON.stringify({ phase: "term-orphan635", root: tool.pid, child: child.pid, cleanup: tool.owner.cleanup }),
      )
    } finally {
      await writeFile(path.join(dir, "finish"), "finish")
      const child = await ready(path.join(dir, "child"))
      const until = Date.now() + 5000
      while (await alive(child.pid)) {
        if (Date.now() >= until) throw new Error("Fixture orphan did not close after owner protocol")
        await scheduler.wait(10)
      }
      await tool.owner.stop()
      await rm(dir, { recursive: true, force: true })
    }
  },
  20000,
)
