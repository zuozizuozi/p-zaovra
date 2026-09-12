import type { EventEmitter } from "node:events"

export function installUpdate(input: {
  updater: Pick<EventEmitter, "once" | "removeListener"> & { quitAndInstall(): void }
  lifecycle: Pick<EventEmitter, "once" | "removeListener">
  quitting: (value: boolean) => void
}) {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout)
      input.updater.removeListener("error", failed)
      input.lifecycle.removeListener("before-quit-for-update", accepted)
    }
    const failed = (error: unknown) => {
      cleanup()
      input.quitting(false)
      reject(error instanceof Error ? error : new Error(String(error)))
    }
    const accepted = () => {
      cleanup()
      resolve()
    }
    const timeout = setTimeout(() => failed(new Error("Update installer did not start")), 30_000)
    input.updater.once("error", failed)
    input.lifecycle.once("before-quit-for-update", accepted)
    input.quitting(true)
    try {
      input.updater.quitAndInstall()
    } catch (error) {
      failed(error)
    }
  })
}
