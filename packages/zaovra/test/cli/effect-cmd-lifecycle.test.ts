import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { scheduler } from "node:timers/promises"

async function lifecycle(mode: string, code: number, signal?: "SIGTERM" | "SIGINT") {
  const directory = await mkdtemp(path.join(tmpdir(), "zaovra-cli-dispose-"))
  const child = spawn(
    process.execPath,
    ["--conditions=browser", path.join(import.meta.dir, "fixture/effect-cmd-lifecycle.ts"), directory, mode],
    { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, ZAOVRA_PURE: "1" } },
  )
  let stderr = ""
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk)
  })
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject)
    child.once("close", resolve)
  })
  const events = async () => JSON.parse(await readFile(path.join(directory, "events.json"), "utf8")) as string[]
  try {
    if (signal) {
      const until = Date.now() + 15000
      while (!(await events().catch(() => [] as string[])).includes("handler-ready")) {
        if (child.exitCode !== null || child.signalCode !== null || Date.now() > until)
          throw new Error("CLI did not become ready: " + stderr)
        await scheduler.wait(10)
      }
      child.kill(signal)
    }
    expect(await closed, stderr).toBe(code)
    const result = await events()
    console.info(JSON.stringify({ phase: "effect-cmd-lifecycle634", mode, code, events: result }))
    expect(result.filter((item) => item === "dispose-started")).toHaveLength(1)
    expect(result.filter((item) => item === "dispose-completed")).toHaveLength(1)
    expect(result.at(-1)).toBe("top-finally-completed")
    expect(result.indexOf("dispose-completed")).toBeGreaterThan(result.indexOf("dispose-started"))
    if (code === 143 || code === 130) {
      expect(result).toContain("handler-interrupted")
      expect(result).not.toContain("command-error")
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill()
    await closed
    await rm(directory, { recursive: true, force: true })
  }
}

test.each([
  ["normal", 0],
  ["error", 1],
  ["event-term", 143],
  ["event-int", 130],
  ["event-repeat", 143],
] as const)(
  "real effectCmd outer disposer completes before %s exits",
  async (mode, code) => {
    await lifecycle(mode, code)
  },
  30000,
)

test.skipIf(process.platform === "win32")(
  "real CLI OS SIGTERM waits for outer disposer",
  async () => {
    await actualEntry("SIGTERM")
  },
  30000,
)

test.skipIf(process.platform === "win32")(
  "real CLI OS SIGINT waits for outer disposer",
  async () => {
    await actualEntry("SIGINT")
  },
  30000,
)

async function actualEntry(signal?: "SIGTERM" | "SIGINT") {
  const directory = await mkdtemp(path.join(tmpdir(), "zaovra-cli-entry-dispose-"))
  const child = spawn(
    process.execPath,
    [
      "--conditions=browser",
      "--preload",
      path.join(import.meta.dir, "fixture/effect-cmd-entry-preload.ts"),
      path.join(import.meta.dir, "../../src/index.ts"),
      "--pure",
      "debug",
      "config",
    ],
    {
      cwd: path.join(import.meta.dir, "../.."),
      stdio: ["ignore", "ignore", "pipe"],
      env: {
        ...process.env,
        ZAOVRA_PURE: "1",
        ZAOVRA_TEST_DISPOSER_DIR: directory,
        ZAOVRA_TEST_DISPOSER_SIGNAL: signal ? "external" : "event",
      },
    },
  )
  let stderr = ""
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk)
  })
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject)
    child.once("close", resolve)
  })
  const events = async () => JSON.parse(await readFile(path.join(directory, "events.json"), "utf8")) as string[]
  try {
    if (signal) {
      const until = Date.now() + 15000
      while (!(await events().catch(() => [] as string[])).includes("dispose-started")) {
        if (child.exitCode !== null || child.signalCode !== null || Date.now() > until)
          throw new Error("Actual CLI did not reach disposal: " + stderr)
        await scheduler.wait(5)
      }
      child.kill(signal)
    }
    expect(await closed, stderr).toBe(signal === "SIGINT" ? 130 : 143)
    expect(await events()).toEqual(["dispose-started", "dispose-completed", "process-exit"])
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill()
    await closed
    await rm(directory, { recursive: true, force: true })
  }
}

test("actual src/index.ts waits for disposal after a signal event during finally", async () => {
  await actualEntry()
}, 30000)
