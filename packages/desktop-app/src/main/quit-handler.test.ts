import { expect, test } from "bun:test"
import { createQuitHandler } from "./quit-handler"

test("repeated quit events wait for one cleanup before allowing exit", async () => {
  const stopped = Promise.withResolvers<void>()
  const calls: string[] = []
  const handler = createQuitHandler({
    stop: () => {
      calls.push("stop")
      return stopped.promise
    },
    quit: () => calls.push("quit"),
    failed: () => calls.push("failed"),
  })
  const event = { preventDefault: () => calls.push("prevent") }
  handler(event)
  handler(event)
  await Bun.sleep(0)
  expect(calls).toEqual(["prevent", "prevent", "stop"])
  stopped.resolve()
  await Bun.sleep(0)
  handler(event)
  expect(calls).toEqual(["prevent", "prevent", "stop", "quit"])
})

test("failed cleanup keeps the app open and permits a later quit attempt", async () => {
  const calls: string[] = []
  const handler = createQuitHandler({
    stop: async () => {
      throw new Error("stop failed")
    },
    quit: () => calls.push("quit"),
    failed: () => calls.push("failed"),
  })
  const event = { preventDefault: () => calls.push("prevent") }
  handler(event)
  await Bun.sleep(0)
  handler(event)
  await Bun.sleep(0)
  expect(calls).toEqual(["prevent", "failed", "prevent", "failed"])
})
