import { expect, test } from "bun:test"
import { toolErrorText } from "./tool-error-text"
test("700 hides host stack while preserving command exit and application stderr", () => {
  const message =
    "Error: Command exited with code 2\nMissing required argument\n    at SessionRunner.runTurn (core/src/session/runner/llm.ts:1:1)\n    at ToolRegistry.settle (core/src/tool/registry.ts:1:1)"
  expect(toolErrorText(message)).toBe("Command exited with code 2\nMissing required argument")
  expect(message).toContain("ToolRegistry.settle")
  expect(toolErrorText("Traceback:\n  File app.py, line 8\nValueError: invalid row")).toContain(
    "ValueError: invalid row",
  )
})
