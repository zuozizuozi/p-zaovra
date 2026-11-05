import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { scheduler } from "node:timers/promises"

type Event = { name: string; at: number; pid?: number }
async function legacy(mode: string, external = false) {
  const directory = await mkdtemp(path.join(tmpdir(), "zaovra-legacy-signal-"))
  const child = spawn(process.execPath, [path.join(import.meta.dir, "fixture/legacy-signal.ts"), directory, mode], {
    stdio: ["ignore", "pipe", "pipe"],
  })
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk)
  })
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk)
  })
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject)
    child.once("close", resolve)
  })
  const events = async () => JSON.parse(await readFile(path.join(directory, "events.json"), "utf8")) as Event[]
  try {
    if (external) {
      const until = Date.now() + 12000
      while (!(await events().catch(() => [] as Event[])).some((event) => event.name === "work-ready")) {
        if (Date.now() >= until || child.exitCode !== null) throw new Error("Legacy work not ready: " + stderr)
        await scheduler.wait(10)
      }
      await scheduler.wait(80)
      child.kill("SIGTERM")
    }
    const code = await closed
    const result = await events()
    console.info(JSON.stringify({ phase: "legacy636", mode, code, stdout, events: result }))
    expect(code, stderr).toBe(mode.includes("normal") ? 0 : mode.includes("int") ? 130 : 143)
    const names = result.map((event) => event.name)
    if (mode.startsWith("app") || mode.startsWith("owned")) {
      const work = JSON.parse(await readFile(path.join(directory, "child.json"), "utf8")) as { pid: number }
      const running =
        process.platform === "linux"
          ? await readFile("/proc/" + work.pid + "/stat", "utf8")
              .then((data) => !["Z", "X"].includes(data.slice(data.lastIndexOf(") ") + 2).split(" ")[0]))
              .catch((error: NodeJS.ErrnoException) => {
                if (error.code === "ENOENT") return false
                throw error
              })
          : (() => {
              try {
                process.kill(work.pid, 0)
                return true
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ESRCH") return false
                throw error
              }
            })()
      expect(running).toBe(false)
      const completed = await readFile(path.join(directory, "work-completed.txt"), "utf8").catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined
          throw error
        },
      )
      expect(completed).toBe(mode.includes("normal") ? "completed" : undefined)
    }
    if (mode.includes("normal")) {
      expect(names).toContain("work-completed")
      expect(stdout).toContain("work-completed-after-signal")
      return
    }
    if (mode.startsWith("cooperative") && !mode.includes("repeat")) {
      expect(names).toContain("dispose-completed")
      expect(names).toContain("top-finally")
      expect(
        result.find((event) => event.name === "dispose-completed")!.at -
          result.find((event) => event.name === "dispose-started")!.at,
      ).toBeGreaterThanOrEqual(650)
      return
    }
    expect(names).not.toContain("work-completed")
    expect(stdout).not.toContain("work-completed-after-signal")
    if (mode.includes("repeat")) {
      expect(names).not.toContain("dispose-completed")
      expect(
        result.find((event) => event.name === "force-started")!.at -
          result.find((event) => event.name === "second-signal")!.at,
      ).toBeLessThan(200)
    } else if (!external) {
      const elapsed = result.at(-1)!.at - result.find((event) => event.name === "signal-sent")!.at
      expect(elapsed).toBeGreaterThanOrEqual(200)
      expect(elapsed).toBeLessThan(2000)
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    await closed
    await rm(directory, { recursive: true, force: true })
  }
}

test.each([
  "timer-normal",
  "app-normal",
  "timer-term",
  "timer-int",
  "app-term",
  "app-int",
  "timer-repeat",
  "app-repeat",
  "cooperative-term",
  "cooperative-int",
  "cooperative-repeat",
])(
  "legacy and cooperative signal lifecycle: %s",
  async (mode) => {
    await legacy(mode)
  },
  25000,
)

test.skipIf(process.platform === "win32")(
  "OS SIGTERM cancels a legacy 700ms wait",
  async () => {
    await legacy("timer-external", true)
  },
  25000,
)
test.skipIf(process.platform === "win32")(
  "OS SIGTERM cancels actual AppProcess work without a signal option",
  async () => {
    await legacy("app-external", true)
  },
  25000,
)

test.skipIf(process.platform === "win32")(
  "second signal interrupts an already active five-second owned-tool termination grace",
  async () => {
    await legacy("owned-repeat")
  },
  25000,
)
