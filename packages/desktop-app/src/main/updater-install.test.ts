import { EventEmitter } from "node:events"
import { expect, test } from "bun:test"
import { installUpdate } from "./updater-install"

test("synchronous installer failures restore the running window state", async () => {
  const lifecycle = new EventEmitter()
  const states: boolean[] = []
  const updater = Object.assign(new EventEmitter(), {
    quitAndInstall() {
      throw new Error("installer unavailable")
    },
  })
  await expect(installUpdate({ updater, lifecycle, quitting: (value) => states.push(value) })).rejects.toThrow(
    "installer unavailable",
  )
  expect(states).toEqual([true, false])
  expect(updater.listenerCount("error")).toBe(0)
  expect(lifecycle.listenerCount("before-quit-for-update")).toBe(0)
})

test("an installer that never acknowledges startup times out and restores the window", async () => {
  const lifecycle = new EventEmitter()
  const states: boolean[] = []
  const updater = Object.assign(new EventEmitter(), { quitAndInstall() {} })
  await expect(installUpdate({ updater, lifecycle, quitting: (value) => states.push(value) })).rejects.toThrow(
    "Update installer did not start",
  )
  expect(states).toEqual([true, false])
  expect(updater.listenerCount("error")).toBe(0)
  expect(lifecycle.listenerCount("before-quit-for-update")).toBe(0)
}, 35_000)

test("native error events reject installation and restore the running window state", async () => {
  const lifecycle = new EventEmitter()
  const states: boolean[] = []
  const updater = Object.assign(new EventEmitter(), {
    quitAndInstall() {
      queueMicrotask(() => updater.emit("error", new Error("installer rejected")))
    },
  })
  await expect(installUpdate({ updater, lifecycle, quitting: (value) => states.push(value) })).rejects.toThrow(
    "installer rejected",
  )
  expect(states).toEqual([true, false])
  expect(updater.listenerCount("error")).toBe(0)
  expect(lifecycle.listenerCount("before-quit-for-update")).toBe(0)
})

test("accepted native installation keeps the quitting flag and removes listeners", async () => {
  const lifecycle = new EventEmitter()
  const states: boolean[] = []
  const updater = Object.assign(new EventEmitter(), {
    quitAndInstall() {
      queueMicrotask(() => lifecycle.emit("before-quit-for-update"))
    },
  })
  await installUpdate({ updater, lifecycle, quitting: (value) => states.push(value) })
  expect(states).toEqual([true])
  expect(updater.listenerCount("error")).toBe(0)
  expect(lifecycle.listenerCount("before-quit-for-update")).toBe(0)
})
