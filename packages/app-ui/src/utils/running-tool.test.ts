import { expect, test } from "bun:test"
import type { ToolPart, ToolState } from "@zaovra-ai/sdk/v2"
import { runningTool } from "./running-tool"

const tool = (state: ToolState, name = "bash"): ToolPart => ({
  id: "part",
  sessionID: "session",
  messageID: "message",
  callID: "call",
  type: "tool",
  tool: name,
  state,
})

test("historical output and pending input do not imply a running tool", () => {
  expect(
    runningTool([
      tool({ status: "completed", input: {}, output: "ok", title: "done", metadata: {}, time: { start: 1, end: 2 } }),
      tool({ status: "error", input: {}, error: "failed", time: { start: 3, end: 4 } }),
      tool({ status: "pending", input: {}, raw: "" }),
    ]),
  ).toBeUndefined()
})

test("uses the last live tool's actual start and a bounded first command line", () => {
  expect(
    runningTool([
      tool({ status: "running", input: {}, time: { start: 1 } }, "read"),
      tool({ status: "running", input: { command: "npm test\nsecret-free second line" }, time: { start: 42 } }),
      tool({ status: "completed", input: {}, output: "ok", title: "done", metadata: {}, time: { start: 43, end: 44 } }),
    ]),
  ).toEqual({ started: 42, label: "npm test" })
  expect(runningTool([tool({ status: "running", input: {}, time: { start: 3 } }, "read")])).toEqual({
    started: 3,
    label: "read",
  })
})
