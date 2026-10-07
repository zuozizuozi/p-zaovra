import { expect, test } from "bun:test"
import { desktopProjectGroup } from "./desktop-project-group"
import { pathKey, pathsEqual } from "@/utils/path-key"

const groups = [
  { server: "local", project: { worktree: "C:/Projects/deleted" } },
  { server: "local", project: { worktree: "C:/Projects/Game", sandboxes: ["C:/Worktrees/Game-test"] } },
  { server: "remote", project: { worktree: "C:/Projects/Game" } },
]

test.each(["C:\\Projects\\Game", "C:/Projects/Game", "c:/projects/GAME", "C:/Projects/Game/", "c:\\PROJECTS\\game\\"])(
  "groups Windows session and draft directory %s under its actual project",
  (directory) => expect(desktopProjectGroup(groups, "local", directory)).toBe(groups[1]),
)

test("workspace aliases use the same Windows comparison", () => {
  expect(desktopProjectGroup(groups, "local", "c:\\WORKTREES\\game-TEST\\")).toBe(groups[1])
})

test("equivalent paths do not cross server boundaries", () => {
  expect(desktopProjectGroup(groups, "remote", "c:\\projects\\game")).toBe(groups[2])
  expect(desktopProjectGroup(groups, "removed-server", "C:/Projects/Game")).toBeUndefined()
})

test("POSIX and WSL directories preserve case sensitivity", () => {
  const projects = [
    { server: "wsl", project: { worktree: "/home/user/game" } },
    { server: "wsl", project: { worktree: "/home/user/Game" } },
  ]
  expect(desktopProjectGroup(projects, "wsl", "/home/user/Game/")).toBe(projects[1])
  expect(pathsEqual("/home/user/Game", "/home/user/game")).toBe(false)
  expect(pathsEqual("/home/user/a\\b", "/home/user/a/b")).toBe(false)
})

test("UNC paths normalize separators, case and trailing slash", () => {
  expect(pathsEqual("\\\\HOST\\Share\\Game\\", "//host/share/game/")).toBe(true)
  expect(pathsEqual("//HOST/Share/Game", "//host/share/game")).toBe(true)
})

test("persisted path keys retain their existing case and drive-root behavior", () => {
  expect(String(pathKey("C:\\Projects\\Game\\"))).toBe("C:/Projects/Game")
  expect(String(pathKey("C:\\"))).toBe("C:/")
  expect(pathsEqual("C:\\", "c:/")).toBe(true)
})

test("unresolved tabs retain the existing same-server fallback", () => {
  expect(desktopProjectGroup(groups, "local")).toBe(groups[0])
  expect(desktopProjectGroup(groups, "local", "C:/Elsewhere")).toBe(groups[0])
})
