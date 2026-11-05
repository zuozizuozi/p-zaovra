import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

test.each([
  "legacy-term",
  "legacy-int",
  "repeat-term",
  "repeat-int",
  "repeat-warn",
  "repeat-print",
  "repeat-hang",
  "repeat-reject",
  "repeat-removed",
])(
  "forced exit preserves the configured final diagnostic: %s",
  async (mode) => {
    const directory = await mkdtemp(path.join(tmpdir(), "zaovra-force-log-"))
    const child = spawn(process.execPath, [path.join(import.meta.dir, "fixture/force-log.ts"), directory, mode], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        XDG_DATA_HOME: path.join(directory, "data"),
        XDG_CONFIG_HOME: path.join(directory, "config"),
        XDG_CACHE_HOME: path.join(directory, "cache"),
        XDG_STATE_HOME: path.join(directory, "state"),
        ZAOVRA_PRINT_LOGS: mode.includes("print") ? "1" : "0",
      },
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => (stdout += String(chunk)))
    child.stderr.on("data", (chunk) => (stderr += String(chunk)))
    const closed = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject)
      child.once("close", resolve)
    })
    try {
      expect(await closed, stderr).toBe(mode.includes("int") ? 130 : 143)
      expect(stdout).toBe("payload")
      if (mode.includes("hang")) expect(stderr).toContain("Forced diagnostic flush timed out")
      else if (mode.includes("reject")) expect(stderr).toContain("synthetic logger drain failure")
      else if (mode.includes("print")) expect(stderr).toContain('message="cleanup unverified"')
      else expect(stderr).toBe("")
      const cleanup = JSON.parse(await readFile(path.join(directory, "cleanup.json"), "utf8"))
      expect(cleanup.status).toBe("unverified")
      const exited = JSON.parse(await readFile(path.join(directory, "exit.json"), "utf8"))
      expect(exited.at - cleanup.at).toBeLessThan(2000)
      if (mode.includes("hang")) expect(exited.at - cleanup.at).toBeGreaterThanOrEqual(200)
      const file = JSON.parse(await readFile(path.join(directory, "log-path.json"), "utf8")) as string
      expect(file.startsWith(directory + path.sep)).toBe(true)
      const log = await readFile(file, "utf8")
      console.info(JSON.stringify({ mode, cleanup, exitDelay: exited.at - cleanup.at, logBytes: log.length }))
      if (mode.includes("warn")) {
        expect(log).not.toContain("cleanup unverified")
        return
      }
      expect(log).toContain('message="cleanup unverified"')
      expect(log).toContain(`pid=${cleanup.pid}`)
      expect(log).toContain("status=unverified")
      expect(log).toContain(`reason=${JSON.stringify(cleanup.reason)}`)
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
      await closed
      await rm(directory, { recursive: true, force: true })
    }
  },
  15000,
)
