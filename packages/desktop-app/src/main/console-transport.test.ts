import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Writable } from "node:stream"
import log from "electron-log/node"
import { guardConsoleTransport } from "./console-transport"

for (const channel of ["stdout", "stderr"] as const) {
  test(`closing the launcher's ${channel} pipe preserves the process and file logs`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "zaovra-console-"))
    try {
      const build = await Bun.build({
        entrypoints: [join(import.meta.dir, "console-transport.ts")],
        outdir: directory,
        target: "node",
        format: "esm",
        naming: "guard.mjs",
      })
      expect(build.success).toBe(true)
      const file = join(directory, "desktop.log")
      const script = join(directory, "child.mjs")
      await Bun.write(
        script,
        `
import log from ${JSON.stringify(import.meta.resolve("electron-log/node"))}
import { guardConsoleTransport } from './guard.mjs'
log.transports.file.resolvePathFn = () => ${JSON.stringify(file)}
guardConsoleTransport(log.transports.console)
process.on('message', () => {
  log.${channel === "stderr" ? "error" : "info"}('broken-pipe-probe')
  setTimeout(() => {
    log.info('file-logging-still-alive')
    process.send({disabled: log.transports.console.level === false})
    process.disconnect()
  }, 100)
})
process.send('ready')
`,
      )
      const child = spawn("node", [script], { stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true })
      const messages: unknown[] = []
      const errors: string[] = []
      child.stderr.on("data", (chunk) => errors.push(String(chunk)))
      child.stdout.resume()
      child.on("message", (message) => {
        if (message !== "ready") {
          messages.push(message)
          return
        }
        // Disconnect the real OS pipe before allowing the logger to write.
        child[channel].once("close", () => child.send("write"))
        child[channel].destroy()
      })
      const exit = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject)
        child.once("close", resolve)
      })
      expect({ exit, errors: errors.join("") }).toEqual({ exit: 0, errors: "" })
      expect(messages).toEqual([{ disabled: true }])
      expect(await Bun.file(file).text()).toContain("file-logging-still-alive")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 10_000)
}

test("synchronous EPIPE disables repeated console writes without disabling file transport", () => {
  const logger = log.create({ logId: "sync-broken-pipe" })
  let calls = 0
  logger.transports.console.writeFn = () => {
    calls++
    throw Object.assign(new Error("closed"), { code: "EPIPE" })
  }
  guardConsoleTransport(logger.transports.console, [])
  const fileLevel = logger.transports.file.level
  const message = { message: { date: new Date(), level: "info" as const, data: ["probe"] } }
  logger.transports.console.writeFn(message)
  logger.transports.console.writeFn(message)
  expect(calls).toBe(1)
  expect(logger.transports.console.level).toBe(false)
  expect(logger.transports.file.level).toBe(fileLevel)
})

test("unrelated stream and synchronous errors remain visible", () => {
  const logger = log.create({ logId: "other-console-error" })
  const stream = new Writable({
    write(_chunk, _encoding, done) {
      done()
    },
  })
  const error = Object.assign(new Error("not a broken pipe"), { code: "EIO" })
  logger.transports.console.writeFn = () => {
    throw error
  }
  guardConsoleTransport(logger.transports.console, [stream])
  expect(() => stream.emit("error", error)).toThrow(error)
  expect(() => logger.transports.console.writeFn({ message: { date: new Date(), level: "info", data: [] } })).toThrow(
    error,
  )
  expect(logger.transports.console.level).not.toBe(false)
  stream.destroy()
})
