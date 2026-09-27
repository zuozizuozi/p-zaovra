import type { ConsoleTransport } from "electron-log"
import type { Writable } from "node:stream"

export function guardConsoleTransport(
  transport: ConsoleTransport,
  streams: readonly Writable[] = [process.stdout, process.stderr],
) {
  const failed = (error: unknown) => {
    if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "EPIPE") throw error
    // The launcher can disappear while the desktop is still running. Keep file
    // logging alive, and never report this failure through the broken console.
    transport.level = false
  }
  // Socket write failures can arrive after writeFn returns, outside its catch.
  streams.forEach((stream) => stream.on("error", failed))
  const write = transport.writeFn.bind(transport)
  transport.writeFn = (options) => {
    if (transport.level === false) return
    try {
      write(options)
    } catch (error) {
      failed(error)
    }
  }
}
