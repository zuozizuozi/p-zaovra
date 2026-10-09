import { setTimeout } from "node:timers/promises"

const pending = new Map<string, Promise<void>>()
// Keep the former ~4.3s lock-recovery window without electron-store's
// synchronous inner retries. Brief contention still gets quick retries.
const retryDelays = [25, 75, 150, 1000, 3000]

// Serialize mutations per file so a delayed retry cannot overwrite a newer draft
// or resurrect a key that was deleted while that retry was pending.
export function queueStoreWrite(name: string, write: () => void | Promise<void>) {
  const task = (pending.get(name) ?? Promise.resolve()).then(async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        await write()
        return
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? error.code : undefined
        if (attempt >= retryDelays.length || !["EPERM", "EBUSY", "EACCES"].includes(String(code))) {
          console.error("Store write failed", { name, code, attempts: attempt + 1 })
          throw error
        }
        await setTimeout(retryDelays[attempt])
      }
    }
  })
  const settled = task
    .catch(() => {})
    .finally(() => {
      if (pending.get(name) === settled) pending.delete(name)
    })
  pending.set(name, settled)
  return task
}
