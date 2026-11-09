import { expect, test } from "bun:test"
import { moveSidebarItem, sortSidebarItems, sortSidebarSessions } from "./sidebar-order"

test("766 row moves work in both directions and reject foreign or missing keys", () => {
  expect(moveSidebarItem(["a", "b", "c"], "a", "b")).toEqual(["b", "a", "c"])
  expect(moveSidebarItem(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"])
  expect(moveSidebarItem(["a", "b"], "foreign", "b")).toEqual(["a", "b"])
  expect(moveSidebarItem(["a", "b"], "a", "missing")).toEqual(["a", "b"])
})

test("766 saved ordering keeps missing and newly opened projects without duplicating them", () => {
  const projects = [{ key: "remote:one" }, { key: "local:one" }, { key: "local:two" }]
  expect(sortSidebarItems(projects, ["gone", "local:two", "local:one"], (item) => item.key).map((p) => p.key)).toEqual([
    "local:two",
    "local:one",
    "remote:one",
  ])
})

test("766 new admissions precede saved session order while later history pages stay below it", () => {
  const sessions = [
    { id: "history", time: { created: 1, updated: 100 } },
    { id: "first", time: { created: 2, updated: 200 } },
    { id: "second", time: { created: 3, updated: 300 } },
    { id: "admitted", time: { created: 4, updated: 4 } },
  ]
  expect(sortSidebarSessions(sessions, ["first", "gone", "second", "first"]).map((s) => s.id)).toEqual([
    "admitted",
    "first",
    "second",
    "history",
  ])
  expect(sortSidebarSessions(sessions, []).map((s) => s.id)).toEqual(["admitted", "second", "first", "history"])
  sessions[0].time.updated = 1000
  expect(sortSidebarSessions(sessions, ["first", "second"]).map((s) => s.id)).toEqual([
    "admitted",
    "first",
    "second",
    "history",
  ])
})
