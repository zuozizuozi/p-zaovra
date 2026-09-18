import { expect, test } from "bun:test"
import { waitForServerHealth } from "./server-health"

test("publishes readiness only after an HTTP health check succeeds", async () => {
  let calls = 0
  const server = Bun.serve({
    port: 0,
    fetch: () => new Response(null, { status: ++calls < 3 ? 503 : 200 }),
  })
  try {
    await waitForServerHealth(
      async (signal) => (await fetch(server.url, { signal })).ok,
      new Promise<number>(() => {}),
      1000,
      1,
    )
    expect(calls).toBe(3)
  } finally {
    server.stop(true)
  }
})

test("timeout aborts an in-flight health request and stops polling", async () => {
  let calls = 0
  let signal: AbortSignal | undefined
  const server = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) })
  try {
    await expect(
      waitForServerHealth(
        async (current) => {
          calls++
          signal = current
          return (await fetch(server.url, { signal: current })).ok
        },
        new Promise<number>(() => {}),
        30,
        1,
      ),
    ).rejects.toThrow("timed out")
    expect(signal?.aborted).toBe(true)
    await Bun.sleep(15)
    expect(calls).toBe(1)
  } finally {
    server.stop(true)
  }
})

test("child exit wins over a pending health check and cancels it", async () => {
  const exit = Promise.withResolvers<number>()
  let signal: AbortSignal | undefined
  const ready = waitForServerHealth(
    (current) => {
      signal = current
      return new Promise<boolean>(() => {})
    },
    exit.promise,
    1000,
  )
  exit.resolve(7)
  await expect(ready).rejects.toThrow("code 7")
  expect(signal?.aborted).toBe(true)
})

test("a failed probe propagates instead of publishing readiness", async () => {
  const error = new Error("invalid health response")
  await expect(waitForServerHealth(() => Promise.reject(error), new Promise<number>(() => {}))).rejects.toBe(error)
})

test("exit after successful startup does not restart health polling", async () => {
  const exit = Promise.withResolvers<number>()
  let calls = 0
  await waitForServerHealth(
    async () => {
      calls++
      return true
    },
    exit.promise,
    1000,
    1,
  )
  exit.resolve(9)
  await Bun.sleep(10)
  expect(calls).toBe(1)
})
