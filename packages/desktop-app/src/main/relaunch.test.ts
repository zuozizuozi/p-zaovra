import { expect, test } from "bun:test"
import { createRelaunchHandler } from "./relaunch"

test("relaunch waits for cleanup and coalesces repeated requests", async () => {
  const stopped = Promise.withResolvers<void>()
  const calls: string[] = []
  const relaunch = createRelaunchHandler({
    stop: () => {
      calls.push("stop")
      return stopped.promise
    },
    relaunch: () => {
      calls.push("relaunch")
    },
    quitting: (value) => {
      calls.push(`quitting:${value}`)
    },
    failed: () => {
      calls.push("failed")
    },
  })
  const pending = relaunch()
  expect(relaunch()).toBe(pending)
  await Bun.sleep(0)
  expect(calls).toEqual(["quitting:true", "stop"])
  stopped.resolve()
  await pending
  expect(calls).toEqual(["quitting:true", "stop", "relaunch"])
})

test("failed cleanup does not relaunch and permits retry", async () => {
  let attempts = 0
  const calls: string[] = []
  const relaunch = createRelaunchHandler({
    stop: async () => {
      if (++attempts === 1) throw new Error("cleanup failed")
    },
    relaunch: () => {
      calls.push("relaunch")
    },
    quitting: (value) => {
      calls.push(`quitting:${value}`)
    },
    failed: () => {
      calls.push("failed")
    },
  })
  await relaunch()
  expect(calls).toEqual(["quitting:true", "quitting:false", "failed"])
  await relaunch()
  expect(calls).toEqual(["quitting:true", "quitting:false", "failed", "quitting:true", "relaunch"])
})
