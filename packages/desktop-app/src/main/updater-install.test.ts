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
  const calls: unknown[][] = []
  const updater = Object.assign(new EventEmitter(), {
    quitAndInstall(...args: unknown[]) {
      calls.push(args)
      queueMicrotask(() => lifecycle.emit("before-quit-for-update"))
    },
  })
  await installUpdate({ updater, lifecycle, quitting: (value) => states.push(value) })
  // Silent overwrite install that relaunches the app: no installer wizard or folder page.
  expect(calls).toEqual([[true, true]])
  expect(states).toEqual([true])
  expect(updater.listenerCount("error")).toBe(0)
  expect(lifecycle.listenerCount("before-quit-for-update")).toBe(0)
})

test("the database backup finishes before the silent installer starts", async () => {
  const lifecycle = new EventEmitter()
  const order: string[] = []
  const updater = Object.assign(new EventEmitter(), {
    quitAndInstall() {
      order.push("install")
      queueMicrotask(() => lifecycle.emit("before-quit-for-update"))
    },
  })
  await installUpdate({
    updater,
    lifecycle,
    quitting: () => {},
    beforeInstall: async () => {
      await Promise.resolve()
      order.push("backup")
    },
  })
  expect(order).toEqual(["backup", "install"])
})

test("a failed database backup blocks the installer", async () => {
  const lifecycle = new EventEmitter()
  const calls: unknown[] = []
  const updater = Object.assign(new EventEmitter(), { quitAndInstall: () => calls.push("install") })
  await expect(
    installUpdate({
      updater,
      lifecycle,
      quitting: () => {},
      beforeInstall: () => Promise.reject(new Error("backup failed")),
    }),
  ).rejects.toThrow("backup failed")
  expect(calls).toEqual([])
})
