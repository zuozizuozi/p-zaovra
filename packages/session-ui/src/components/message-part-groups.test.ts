import { expect, test } from "bun:test"
import type { Part, ToolPart } from "@zaovra-ai/sdk/v2"
import { groupParts, sameGroups } from "./message-part-groups"

const tool = (id: string, name: string, status: "completed" | "error" = "completed"): ToolPart => ({
  id,
  messageID: "assistant",
  sessionID: "session",
  callID: id,
  type: "tool",
  tool: name,
  state:
    status === "error"
      ? { status, input: { path: id }, error: "unresolved", time: { start: 1, end: 2 } }
      : { status, input: { path: id }, output: "", title: name, metadata: {}, time: { start: 1, end: 2 } },
})
const group = (parts: Part[]) =>
  groupParts(
    parts.map((part) => ({ messageID: part.messageID, part })),
    true,
  )
test("expanded process groups adjacent edit, browser and command operations without crossing failures or prose", () => {
  const prose: Part = { id: "prose", type: "text", text: "explanation", messageID: "assistant", sessionID: "session" }
  const groups = group([
    tool("a", "write"),
    tool("b", "edit"),
    tool("c", "bash"),
    tool("d", "bash_job"),
    tool("e", "browser_navigate"),
    tool("f", "browser_screenshot"),
    tool("bad", "edit", "error"),
    prose,
    tool("last", "edit"),
  ])
  expect(groups.map((g) => (g.type === "context" ? [g.kind, g.refs.length] : ["part", g.ref.partID]))).toEqual([
    ["edit", 2],
    ["command", 2],
    ["browser", 2],
    ["part", "bad"],
    ["part", "prose"],
    ["edit", 1],
  ])
  expect(
    sameGroups(
      groups,
      group([
        tool("a", "write"),
        tool("b", "edit"),
        tool("c", "bash"),
        tool("d", "bash_job"),
        tool("e", "browser_navigate"),
        tool("f", "browser_screenshot"),
        tool("bad", "edit", "error"),
        prose,
        tool("last", "edit"),
      ]),
    ),
  ).toBe(true)
})
test("legacy callers retain individual non-reading tools; unfinished tools never merge", () => {
  const running: ToolPart = { ...tool("running", "write"), state: { status: "running", input: {}, time: { start: 1 } } }
  expect(group([tool("a", "write"), running, tool("b", "edit")]).map((g) => g.type)).toEqual([
    "context",
    "part",
    "context",
  ])
  expect(
    groupParts([tool("a", "write"), tool("b", "edit")].map((part) => ({ messageID: part.messageID, part }))).every(
      (g) => g.type === "part",
    ),
  ).toBe(true)
})
