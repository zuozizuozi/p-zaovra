import { expect, test } from "bun:test"
import { createPinnedSessions, createUnreadMarker, type PinnedSession } from "./sidebar-session-preferences"
import { conversationViewFlags, conversationViewFromLegacy } from "./conversation-view"
import { todoDeliveryComplete } from "../pages/session/composer/todo-delivery"
import type { ServerConnection } from "@/context/server"

test("724 pins persist as UI metadata and distinguish equal IDs on different servers", () => {
  const state = { pins: [] as PinnedSession[] }
  const pins = createPinnedSessions({
    read: () => state.pins,
    write: (items) => {
      state.pins = items
    },
  })
  const a = "fixture-server-a" as ServerConnection.Key
  const b = "fixture-server-b" as ServerConnection.Key
  pins.toggle(a, { id: "same", directory: "/a" })
  pins.toggle(b, { id: "same", directory: "/b" })
  expect(pins.list()).toHaveLength(2)
  const reloaded: PinnedSession[] = JSON.parse(JSON.stringify(pins.list()))
  expect(reloaded.map((item) => item.directory)).toEqual(["/a", "/b"])
  pins.toggle(a, { id: "same", directory: "/a" })
  expect(pins.has(a, "same")).toBe(false)
  expect(pins.has(b, "same")).toBe(true)
  pins.remove(b, "same")
  expect(pins.list()).toEqual([])
  expect(reloaded).toHaveLength(2)
})

test("724 unread marker shares notification counts, survives reload and clears without changing other sessions", () => {
  const state = { unread: {} as Record<string, string | undefined> }
  const reading = createUnreadMarker({
    read: () => state.unread,
    write: (id, directory) => {
      state.unread[id] = directory
    },
  })
  reading.markUnread("a", "/project")
  reading.markUnread("b", "/other")
  expect(reading.count("a", 0)).toBe(1)
  expect(reading.count("a", 3)).toBe(3)
  expect(JSON.parse(JSON.stringify(state.unread))).toEqual({ a: "/project", b: "/other" })
  reading.markViewed("a")
  expect(reading.count("a", 0)).toBe(0)
  expect(reading.count("b", 0)).toBe(1)
  const otherServer = createUnreadMarker({ read: () => ({}), write: () => {} })
  expect(otherServer.count("b", 0)).toBe(0)
})

test("724 view presets preserve the legacy default and expose progressively more presentation detail", () => {
  expect(conversationViewFromLegacy(false, false, false)).toBe("normal")
  expect(conversationViewFromLegacy(true, false, false)).toBe("thinking")
  expect(conversationViewFromLegacy(false, true, false)).toBe("detailed")
  expect(conversationViewFlags("normal")).toEqual({ reasoning: false, shell: false, edit: false })
  expect(conversationViewFlags("thinking")).toEqual({ reasoning: true, shell: false, edit: false })
  expect(conversationViewFlags("detailed")).toEqual({ reasoning: true, shell: true, edit: true })
})

const done = [{ content: "Deliver the change", status: "completed", priority: "high" }]
const success = { time: { created: 2, completed: 3 }, finish: "stop" }
test("724 only a successful settled delivery may summarize a completed todo list", () => {
  expect(todoDeliveryComplete({ todos: done, working: false, userCreated: 1, message: success })).toBe(true)
  expect(todoDeliveryComplete({ todos: done, working: true, userCreated: 1, message: success })).toBe(false)
  expect(todoDeliveryComplete({ todos: done, working: false, userCreated: 4, message: success })).toBe(false)
  expect(todoDeliveryComplete({ todos: [], working: false, userCreated: 1, message: success })).toBe(false)
})
test.each(["pending", "in_progress", "cancelled"])("724 retains %s todos without announcing completion", (status) => {
  expect(
    todoDeliveryComplete({ todos: [{ ...done[0], status }], working: false, userCreated: 1, message: success }),
  ).toBe(false)
})
test.each(["stopped", "interrupted", "tool-calls"])("724 %s is not a delivery", (finish) => {
  expect(todoDeliveryComplete({ todos: done, working: false, userCreated: 1, message: { ...success, finish } })).toBe(
    false,
  )
})
test("724 errored or incomplete assistant output is not a delivery", () => {
  expect(
    todoDeliveryComplete({
      todos: done,
      working: false,
      userCreated: 1,
      message: { ...success, error: { message: "failed" } },
    }),
  ).toBe(false)
  expect(
    todoDeliveryComplete({
      todos: done,
      working: false,
      userCreated: 1,
      message: { time: { created: 2 }, finish: "stop" },
    }),
  ).toBe(false)
})
