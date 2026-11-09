import { expect, mock, test } from "bun:test"
import type { AsyncStorage } from "@solid-primitives/storage"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { createSidebarOrder } from "../../src/utils/sidebar-order"
import { createPinnedSessions } from "../../src/utils/sidebar-session-preferences"
import { ServerConnection } from "../../src/context/server"

const values = new Map<string, string>()
const storage: AsyncStorage = {
  getItem: async (key) => values.get(key) ?? null,
  setItem: async (key, value) => {
    values.set(key, value)
  },
  removeItem: async (key) => {
    values.delete(key)
  },
  clear: async () => {
    values.clear()
  },
  key: async (index) => [...values.keys()][index] ?? null,
  getLength: async () => values.size,
  length: Promise.resolve(0),
}
mock.module("@/context/platform", () => ({ usePlatform: () => ({ platform: "desktop", storage: () => storage }) }))
const { persisted, Persist } = await import("../../src/utils/persist")
const local = ServerConnection.key({ type: "http", http: { url: "http://localhost:4096" } })
function open() {
  return createRoot((dispose) => {
    const [state, setState, , ready] = persisted(
      Persist.global("766-isolated-layout-order"),
      createStore({
        projectOrder: [] as string[],
        sessionOrder: {} as Record<string, string[]>,
        pins: [
          { server: local, sessionID: "one", directory: "F:/one" },
          { server: local, sessionID: "two", directory: "F:/one" },
        ],
      }),
    )
    return {
      dispose,
      ready,
      order: createSidebarOrder({
        read: () => state,
        writeProjects: (keys) => setState("projectOrder", keys),
        writeSessions: (group, keys) => setState("sessionOrder", group, keys),
      }),
      pins: createPinnedSessions({ read: () => state.pins, write: (pins) => setState("pins", pins) }),
    }
  })
}
test("766 actual persisted store rehydrates projects, per-server sessions and pins after owner recreation", async () => {
  const first = open()
  await first.ready.promise
  first.order.setProjectOrder(["local:two", "local:one"])
  first.order.setSessionOrder("local:one", ["two", "one", "two"])
  first.order.setSessionOrder("remote:one", ["remote"])
  first.pins.reorder([`${local}:two`, `${local}:one`])
  await Bun.sleep(20)
  expect([...values.values()].join("")).toContain("local:two")
  first.dispose()
  const second = open()
  await second.ready.promise
  expect(second.order.projectOrder()).toEqual(["local:two", "local:one"])
  expect(second.order.sessionOrder("local:one")).toEqual(["two", "one"])
  expect(second.order.sessionOrder("remote:one")).toEqual(["remote"])
  expect(second.pins.list().map((p) => p.sessionID)).toEqual(["two", "one"])
  second.dispose()
})
