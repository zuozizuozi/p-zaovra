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

describe("owned tool process trees", () => {
  test("registers descendants across parent levels, without adopting a recycled parent PID", () => {
    const root = { pid: 10, ppid: 1, birth: "boot:100" }
    const known = new Map([["10:boot:100", root]])
    ProcessTree.observe(known, [
      { pid: 12, ppid: 11, birth: "boot:120" },
      { pid: 11, ppid: 10, birth: "boot:110" },
      { pid: 99, ppid: 1, birth: "boot:90" },
      root,
    ])
    expect([...known.values()].map((item) => item.pid).sort()).toEqual([10, 11, 12])
    ProcessTree.observe(known, [
      { pid: 10, ppid: 1, birth: "boot:200" },
      { pid: 20, ppid: 10, birth: "boot:210" },
      { pid: 21, ppid: 11, birth: "boot:220" },
      { pid: 11, ppid: 1, birth: "boot:110" },
    ])
    expect([...known.values()].map((item) => item.pid).sort()).toEqual([10, 11, 12, 21])
  })

  test("does not adopt older Windows orphans that happen to name a reused parent PID", () => {
    const root = { pid: 10, ppid: 1, birth: "200" }
    const known = new Map([["10:200", root]])
    ProcessTree.observe(known, [root, { pid: 11, ppid: 10, birth: "100" }])
    expect(known.size).toBe(1)
  })

  test.skipIf(!ProcessTree.supported())(
    "stops a detached three-level tool tree and preserves an unrelated process",
    async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "zaovra-owned-tree-"))
      const unrelated = spawn(process.execPath, ["-e", sleeper(path.join(directory, "unrelated.json"))], {
        stdio: "ignore",
      })
      const unrelatedPID = (await ready(path.join(directory, "unrelated.json"))).pid
      const unrelatedIdentity = await ProcessTreeNative.identity(unrelatedPID)
      const root = spawn(process.execPath, ["-e", tree(directory)], { detached: true, stdio: "ignore" })
      const owner = await ProcessTree.track(root)
      try {
        const rootInfo = await ready(path.join(directory, "root.json"))
        const childInfo = await ready(path.join(directory, "child.json"))
        const leafInfo = await ready(path.join(directory, "leaf.json"))
        expect(owner).toBeDefined()
        const tracked = await owner!.observe()
        expect(tracked.map((item) => item.pid)).toContain(rootInfo.pid)
        expect(tracked.map((item) => item.pid)).toContain(childInfo.pid)
        expect(tracked.map((item) => item.pid)).toContain(leafInfo.pid)
        expect(tracked.map((item) => item.pid)).not.toContain(unrelatedPID)
        console.info(JSON.stringify({ phase: "owned-tree-before-stop", owned: tracked, unrelated: unrelatedIdentity }))
        expect(unrelatedIdentity).toBeDefined()
        await ProcessTreeNative.signal(
          { ...unrelatedIdentity!, birth: String(BigInt(unrelatedIdentity!.birth.split(":").at(-1)!) + 1n) },
          "SIGKILL",
        )
        expect((await ProcessTreeNative.identity(unrelatedPID))?.birth).toBe(unrelatedIdentity?.birth)
        const stopping = owner!.stop("SIGTERM", 100)
        expect(owner!.stop()).toBe(stopping)
        await stopping
        for (const pid of [rootInfo.pid, childInfo.pid, leafInfo.pid])
          expect(await ProcessTreeNative.identity(pid)).toBeUndefined()
        expect((await ProcessTreeNative.identity(unrelatedPID))?.birth).toBe(unrelatedIdentity?.birth)
        const remaining = await Promise.all(
          [rootInfo.pid, childInfo.pid, leafInfo.pid].map((pid) => ProcessTreeNative.identity(pid)),
        )
        console.info(
          JSON.stringify({
            phase: "owned-tree-after-stop",
            owned_alive: remaining.some((item) => item !== undefined),
            remaining,
            unrelated: await ProcessTreeNative.identity(unrelatedPID),
          }),
        )
      } finally {
        await owner?.stop()
        if (unrelatedIdentity) await ProcessTreeNative.signal(unrelatedIdentity, "SIGKILL")
        await rm(directory, { recursive: true, force: true })
      }
    },
    60_000,
  )

  test.skipIf(!ProcessTree.supported())(
    "retains a registered detached descendant after its parent exits",
    async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "zaovra-owned-orphan-"))
      const root = spawn(process.execPath, ["-e", tree(directory)], { detached: true, stdio: "ignore" })
      const owner = await ProcessTree.track(root)
      try {
        const rootInfo = await ready(path.join(directory, "root.json"))
        const childInfo = await ready(path.join(directory, "child.json"))
        const leafInfo = await ready(path.join(directory, "leaf.json"))
        const tracked = await owner!.observe()
        const identity = tracked.find((item) => item.pid === rootInfo.pid)!
        await ProcessTreeNative.signal(identity, "SIGKILL")
        await owner!.stop("SIGTERM", 100)
        expect(await ProcessTreeNative.identity(childInfo.pid)).toBeUndefined()
        expect(await ProcessTreeNative.identity(leafInfo.pid)).toBeUndefined()
      } finally {
        await owner?.stop()
        await rm(directory, { recursive: true, force: true })
      }
    },
    60_000,
  )
})
