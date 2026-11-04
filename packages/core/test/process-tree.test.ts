import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { scheduler } from "node:timers/promises"
import { ProcessTree } from "@zaovra-ai/core/process-tree"
import { ProcessTreeNative } from "#process-tree-native"

async function ready(file: string) {
  const deadline = Date.now() + 10_000
  for (;;) {
    const value = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return
      throw error
    })
    if (value) return JSON.parse(value) as { pid: number; child?: number; pgid?: number }
    if (Date.now() >= deadline) throw new Error(`Process did not publish readiness: ${file}`)
    await scheduler.wait(10)
  }
}

function sleeper(file: string) {
  return `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(file)},JSON.stringify({pid:process.pid}));setTimeout(()=>process.exit(0),120000);setInterval(()=>{},60000)`
}

function tree(directory: string) {
  const leaf = sleeper(path.join(directory, "leaf.json"))
  const child = `const fs=require('node:fs');const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(leaf)}],{detached:true,stdio:'ignore'});fs.writeFileSync(${JSON.stringify(path.join(directory, "child.json"))},JSON.stringify({pid:process.pid,child:c.pid}));setTimeout(()=>process.exit(0),120000);setInterval(()=>{},60000)`
  return `const fs=require('node:fs');const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{detached:true,stdio:'ignore'});fs.writeFileSync(${JSON.stringify(path.join(directory, "root.json"))},JSON.stringify({pid:process.pid,child:c.pid}));setTimeout(()=>process.exit(0),120000);setInterval(()=>{},60000)`
}

describe("native owned tool process trees", () => {
  test.skipIf(!ProcessTree.supported())(
    "stops detached descendants and preserves an unrelated process",
    async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "zaovra-native-tree-"))
      const unrelated = spawn(process.execPath, ["-e", sleeper(path.join(directory, "unrelated.json"))], {
        stdio: "ignore",
      })
      const unrelatedPID = (await ready(path.join(directory, "unrelated.json"))).pid
      const unrelatedIdentity = await ProcessTreeNative.identity(unrelatedPID)
      const launched = await ProcessTree.start(process.execPath, ["-e", tree(directory)], {
        stdio: ["ignore", "ignore", "ignore"],
      })
      try {
        const root = await ready(path.join(directory, "root.json"))
        const child = await ready(path.join(directory, "child.json"))
        const leaf = await ready(path.join(directory, "leaf.json"))
        expect(launched.pid).toBe(root.pid)
        const pids = [root.pid, child.pid, leaf.pid]
        const before = await Promise.all(pids.map((pid) => ProcessTreeNative.identity(pid)))
        expect(before.every(Boolean)).toBe(true)
        console.info(
          JSON.stringify({
            phase: "native-owned-before-stop623",
            supervisor: await ProcessTreeNative.identity(launched.proc.pid!),
            owned: before,
            unrelated: unrelatedIdentity,
          }),
        )
        const stopping = launched.owner.stop("SIGTERM", 100)
        expect(launched.owner.stop()).toBe(stopping)
        await stopping
        const remaining = await Promise.all(pids.map((pid) => ProcessTreeNative.identity(pid)))
        expect(remaining).toEqual([undefined, undefined, undefined])
        expect((await ProcessTreeNative.identity(unrelatedPID))?.birth).toBe(unrelatedIdentity?.birth)
        console.info(
          JSON.stringify({
            phase: "native-owned-after-stop623",
            remaining,
            unrelated: await ProcessTreeNative.identity(unrelatedPID),
          }),
        )
      } finally {
        await launched.owner.stop()
        if (unrelatedIdentity) await ProcessTreeNative.signal(unrelatedIdentity, "SIGKILL")
        await rm(directory, { recursive: true, force: true })
      }
    },
    60000,
  )

  test.skipIf(!ProcessTree.supported())(
    "reaps a detached child after its root exits immediately",
    async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "zaovra-native-orphan-"))
      const childCode = sleeper(path.join(directory, "child.json"))
      const code =
        "const child=require('node:child_process').spawn(process.execPath,['-e'," +
        JSON.stringify(childCode) +
        "],{detached:true,stdio:'ignore'});child.unref();require('node:fs').writeFileSync(" +
        JSON.stringify(path.join(directory, "root.json")) +
        ",JSON.stringify({pid:process.pid,child:child.pid}));process.exit(0)"
      const launched = await ProcessTree.start(process.execPath, ["-e", code], {
        stdio: ["ignore", "ignore", "ignore"],
      })
      try {
        const root = await ready(path.join(directory, "root.json"))
        expect(await launched.closed).toEqual([0, null])
        expect(await ProcessTreeNative.identity(root.child!)).toBeUndefined()
        console.info(
          JSON.stringify({
            phase: "native-root-exit623",
            root,
            descendant_after_close: (await ProcessTreeNative.identity(root.child!)) ?? null,
          }),
        )
      } finally {
        await launched.owner.stop()
        await rm(directory, { recursive: true, force: true })
      }
    },
    60000,
  )

  test.skipIf(process.platform !== "win32")(
    "rejects an unrelated PID without assigning processes by PID",
    async () => {
      const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000);setTimeout(()=>process.exit(0),30000)"], {
        stdio: "ignore",
      })
      const identity = await ProcessTreeNative.identity(child.pid!)
      expect(identity).toBeDefined()
      const job = await ProcessTreeNative.createJob()
      try {
        expect(() => job.verify(child.pid!)).toThrow("not a member")
        await job.stop()
        expect((await ProcessTreeNative.identity(child.pid!))?.birth).toBe(identity!.birth)
      } finally {
        await job.stop()
        if (identity) await ProcessTreeNative.signal(identity, "SIGKILL")
      }
    },
    30000,
  )

  test.skipIf(process.platform !== "linux" || !ProcessTree.supported())(
    "reaps a detached child forked by a TERM handler",
    async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "zaovra-term-fork-"))
      const code = `process.on('SIGTERM',()=>{const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(sleeper(path.join(directory, "child.json")))}],{detached:true,stdio:'ignore'});c.unref();require('node:fs').writeFileSync(${JSON.stringify(path.join(directory, "fork.json"))},JSON.stringify({pid:process.pid,child:c.pid}));setTimeout(()=>process.exit(0),100)});require('node:fs').writeFileSync(${JSON.stringify(path.join(directory, "ready.json"))},JSON.stringify({pid:process.pid}));setTimeout(()=>process.exit(0),120000);setInterval(()=>{},60000)`
      const launched = await ProcessTree.start(process.execPath, ["-e", code], {
        stdio: ["ignore", "ignore", "ignore"],
      })
      try {
        await ready(path.join(directory, "ready.json"))
        await launched.owner.stop("SIGTERM", 300)
        const forked = await ready(path.join(directory, "fork.json"))
        expect(await ProcessTreeNative.identity(forked.pid)).toBeUndefined()
        expect(await ProcessTreeNative.identity(forked.child!)).toBeUndefined()
        console.info(
          JSON.stringify({
            phase: "term-handler-fork623",
            forked,
            remaining: [
              (await ProcessTreeNative.identity(forked.pid)) ?? null,
              (await ProcessTreeNative.identity(forked.child!)) ?? null,
            ],
          }),
        )
      } finally {
        await launched.owner.stop()
        await rm(directory, { recursive: true, force: true })
      }
    },
    20000,
  )
})
