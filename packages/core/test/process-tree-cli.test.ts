import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { scheduler } from "node:timers/promises"
import { ProcessTreeNative } from "#process-tree-native"

async function ready(file: string) {
  const deadline = Date.now() + 10_000
  for (;;) {
    const data = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return
      throw error
    })
    if (data) return JSON.parse(data) as { pid: number; child: number }
    if (Date.now() >= deadline) throw new Error(`Readiness deadline exceeded: ${file}`)
    await scheduler.wait(10)
  }
}

// Windows forcibly terminates the target instead of delivering a catchable
// Unix SIGTERM; a Windows pass cannot establish this Linux regression.
test.skipIf(process.platform !== "linux" || !process.versions.bun)(
  "CLI SIGTERM waits for the real spawner's detached tools and leaves unrelated processes alive",
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "zaovra-cli-tree-"))
    const unrelated = spawn(
      process.execPath,
      ["-e", "setTimeout(()=>process.exit(0),15000);setInterval(()=>{},60000)"],
      {
        stdio: "ignore",
      },
    )
    const unrelatedIdentity = await ProcessTreeNative.identity(unrelated.pid!)
    const cli = spawn(process.execPath, [path.join(import.meta.dir, "fixture/tool-tree-cli.ts"), directory], {
      stdio: ["ignore", "ignore", "pipe"],
    })
    const exited = new Promise<number | null>((resolve) => cli.once("exit", resolve))
    const identities: ProcessTreeNative.Identity[] = []
    try {
      const cliInfo = await ready(path.join(directory, "cli.json"))
      const tool = await ready(path.join(directory, "tool.json"))
      const leaf = await ready(path.join(directory, "leaf.json"))
      for (const pid of [cliInfo.pid, tool.pid, leaf.pid]) {
        const identity = await ProcessTreeNative.identity(pid)
        expect(identity).toBeDefined()
        identities.push(identity!)
      }
      const toolStat = (await readFile(`/proc/${tool.pid}/stat`, "utf8")).split(") ").at(-1)!.split(" ")
      const leafStat = (await readFile(`/proc/${leaf.pid}/stat`, "utf8")).split(") ").at(-1)!.split(" ")
      expect(toolStat[2]).not.toBe(leafStat[2])
      await ProcessTreeNative.signal(identities[0], "SIGTERM")
      const exit = await Promise.race([
        exited,
        scheduler.wait(7000).then(() => {
          throw new Error("CLI did not finish owned process cleanup")
        }),
      ])
      expect(exit).toBe(143)
      expect(await readFile(path.join(directory, "interrupted"), "utf8")).toBe("interrupted")
      for (const identity of identities) expect(await ProcessTreeNative.identity(identity.pid)).toBeUndefined()
      expect(unrelatedIdentity).toBeDefined()
      expect((await ProcessTreeNative.identity(unrelated.pid!))?.birth).toBe(unrelatedIdentity!.birth)
    } finally {
      for (const identity of identities.reverse()) await ProcessTreeNative.signal(identity, "SIGKILL")
      if (unrelatedIdentity) await ProcessTreeNative.signal(unrelatedIdentity, "SIGKILL")
      await rm(directory, { recursive: true, force: true })
    }
  },
  20_000,
)
