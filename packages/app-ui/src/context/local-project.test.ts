import { expect, test } from "bun:test"
import { enrichLocalProject } from "./local-project"

test("700 local project name overrides a stale persisted default label", () => {
  const project = { worktree: "C:/Documents/Default Project", expanded: true, name: "Default Project" }
  const result = enrichLocalProject(project, undefined, { name: "研究资料" }, undefined)
  expect(result.name).toBe("研究资料")
  expect(result.worktree).toBe(project.worktree)
  expect(result.expanded).toBe(true)
})

test("700 local metadata stays scoped to its project directory", () => {
  const first = { worktree: "C:/Documents/Default Project", expanded: false }
  const second = { worktree: "C:/Other", expanded: true }
  expect(enrichLocalProject(first, undefined, { name: "资料" }, undefined).name).toBe("资料")
  expect(enrichLocalProject(second, undefined, undefined, undefined).name).toBeUndefined()
  expect(first.worktree).toBe("C:/Documents/Default Project")
})
