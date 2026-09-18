import timers from "node:timers/promises"

// Startup owns the timeout and aborts its in-flight health request on every exit path.
export async function waitForServerHealth(
  check: (signal: AbortSignal) => Promise<boolean>,
  exited: Promise<number>,
  timeoutMs = 30_000,
  intervalMs = 100,
) {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Sidecar health check timed out after ${timeoutMs}ms`)), timeoutMs)
  })
  const gone = exited.then((code) => {
    throw new Error(`Sidecar exited before health check passed with code ${code}`)
  })
  const ready = async () => {
    while (true) {
      controller.signal.throwIfAborted()
      const healthy = await check(controller.signal)
      controller.signal.throwIfAborted()
      if (healthy) return
      await timers.setTimeout(intervalMs, undefined, { signal: controller.signal })
    }
  }
  try {
    await Promise.race([ready(), gone, timeout])
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}
