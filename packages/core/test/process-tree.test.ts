import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { scheduler } from "node:timers/promises"
import { ProcessTree } from "../src/process-tree"

async function ready(file: string) {
  const until = Date.now() + 10000
  for (;;) {
    const data = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return
      throw error
    })
    if (data) return JSON.parse(data) as { pid: number; child?: number }
    if (Date.now() > until) throw new Error("Fixture readiness timeout")
    await scheduler.wait(10)
  }
}
async function alive(pid: number) {
  if (process.platform === "linux") {
    const stat = await readFile("/proc/" + pid + "/stat", "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return ""
      throw error
    })
    return !!stat && !["Z", "X"].includes(stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[0])
  }
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false
    throw error
  }
}
function sleeper(file: string) {
  return (
    'require("node:fs").writeFileSync(' +
    JSON.stringify(file) +
    ",JSON.stringify({pid:process.pid}));setTimeout(()=>process.exit(0),30000);setInterval(()=>{},10000)"
  )
}

test("teardown ends a cross-group tree, is idempotent, and preserves an unrelated child", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "zaovra-simple-tree-"))
  const unrelated = await ProcessTree.start(process.execPath, ["-e", sleeper(path.join(dir, "unrelated"))], {
    stdio: ["ignore", "ignore", "ignore"],
  })
  const leaf = sleeper(path.join(dir, "leaf"))
  const middle =
    'const c=require("node:child_process").spawn(process.execPath,["-e",' +
    JSON.stringify(leaf) +
    '],{detached:true,stdio:"ignore"});' +
    sleeper(path.join(dir, "middle"))
  const root =
    'require("node:child_process").spawn(process.execPath,["-e",' +
    JSON.stringify(middle) +
    '],{detached:true,stdio:"ignore"});' +
    sleeper(path.join(dir, "root"))
  const tool = await ProcessTree.start(process.execPath, ["-e", root], { stdio: ["ignore", "ignore", "ignore"] })
  try {
    await ready(path.join(dir, "unrelated"))
    const ids = await Promise.all(
      ["root", "middle", "leaf"].map(async (name) => (await ready(path.join(dir, name))).pid),
    )
    expect(tool.pid).toBe(ids[0])
    const stopping = tool.owner.stop("SIGTERM", 100)
    expect(tool.owner.stop()).toBe(stopping)
    await stopping
    expect(await Promise.all(ids.map(alive))).toEqual([false, false, false])
    expect(unrelated.proc.exitCode).toBeNull()
    expect(await alive(unrelated.pid)).toBe(true)
    console.info(
      JSON.stringify({
        phase: "tree-stopped629",
        pids: ids,
        remaining: await Promise.all(ids.map(alive)),
        unrelated: unrelated.pid,
        unrelatedAlive: await alive(unrelated.pid),
      }),
    )
  } finally {
    await tool.owner.stop()
    await unrelated.owner.stop()
    await rm(dir, { recursive: true, force: true })
  }
}, 20000)

test("missing executable fails once without executing a fallback", async () => {
  await expect(
    (async () => {
      const child = await ProcessTree.start("zaovra-missing-command-629", [], { stdio: ["ignore", "ignore", "ignore"] })
      await child.closed
    })(),
  ).rejects.toMatchObject({ code: "ENOENT" })
})

test.skipIf(process.platform === "win32")(
  "CLI SIGTERM interrupts the executor and cleans its cross-group tools",
  async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "zaovra-simple-cli-"))
    const unrelated = await ProcessTree.start(process.execPath, ["-e", sleeper(path.join(dir, "unrelated"))], {
      stdio: ["ignore", "ignore", "ignore"],
    })
    await ready(path.join(dir, "unrelated"))
    const cli = spawn(process.execPath, [path.join(import.meta.dir, "fixture/tool-tree-cli.ts"), dir], {
      stdio: ["ignore", "ignore", "pipe"],
    })
    const exit = new Promise<number | null>((resolve) => cli.once("exit", resolve))
    try {
      const parent = await ready(path.join(dir, "cli.json"))
      const tool = await ready(path.join(dir, "tool.json"))
      const leaf = await ready(path.join(dir, "leaf.json"))
      expect(parent.pid).toBe(cli.pid!)
      if (process.platform === "linux") {
        const group = async (pid: number) =>
          (await readFile("/proc/" + pid + "/stat", "utf8")).split(") ").at(-1)!.split(" ")[2]
        expect(await group(tool.pid)).not.toBe(await group(leaf.pid))
      }
      cli.kill("SIGTERM")
      expect(await exit).toBe(143)
      expect(await readFile(path.join(dir, "interrupted"), "utf8")).toBe("interrupted")
      expect(await Promise.all([tool.pid, leaf.pid].map(alive))).toEqual([false, false])
      expect(unrelated.proc.exitCode).toBeNull()
      expect(await alive(unrelated.pid)).toBe(true)
    } finally {
      if (cli.exitCode === null && cli.signalCode === null) cli.kill("SIGTERM")
      await exit
      await unrelated.owner.stop()
      await rm(dir, { recursive: true, force: true })
    }
  },
  20000,
)

test("shutdown waits for executor interruption and rejects new admission", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "zaovra-simple-shutdown-"))
  const cli = spawn(process.execPath, [path.join(import.meta.dir, "fixture/tool-tree-cli.ts"), dir, "shutdown"], {
    stdio: ["ignore", "ignore", "pipe"],
  })
  const exit = new Promise<number | null>((resolve) => cli.once("exit", resolve))
  try {
    expect(await exit).toBe(0)
    expect(await readFile(path.join(dir, "admission-closed"), "utf8")).toBe("closed")
    const tool = await ready(path.join(dir, "tool.json"))
    const leaf = await ready(path.join(dir, "leaf.json"))
    expect(await readFile(path.join(dir, "interrupted"), "utf8")).toBe("interrupted")
    expect(await Promise.all([tool.pid, leaf.pid].map(alive))).toEqual([false, false])
  } finally {
    if (cli.exitCode === null && cli.signalCode === null) cli.kill()
    await exit
    await rm(dir, { recursive: true, force: true })
  }
}, 20000)
