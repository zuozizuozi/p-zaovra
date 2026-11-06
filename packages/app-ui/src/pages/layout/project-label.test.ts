import { describe, expect, test } from "bun:test"
import { displayName } from "./helpers"

describe("697 project display labels", () => {
  const language = { t: () => "默认项目" }
  test("uses the real folder when a stale default name labels another folder", () => {
    expect(displayName({ name: "Default Project", worktree: "C:/Users/test/Documents" }, language)).toBe("Documents")
  })
  test("localizes an automatically created Default Project without changing its directory", () => {
    const project = { name: "Default Project", worktree: "C:/Users/test/Documents/Default Project" }
    expect(displayName(project, language)).toBe("默认项目")
    expect(project.worktree).toBe("C:/Users/test/Documents/Default Project")
  })
  test("keeps explicit user names and ordinary folder names", () => {
    expect(displayName({ name: "我的研究", worktree: "C:/Default Project" }, language)).toBe("我的研究")
    expect(displayName({ worktree: "/work/资料" }, language)).toBe("资料")
    expect(displayName({ worktree: "" }, language)).toBe("默认项目")
  })
})
