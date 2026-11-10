import { expect, test } from "bun:test"
import { formatRevertError } from "./revert-errors"

const translate = (key: string) => key

test("789 explains stale plans and surfaces restore failures from both client error envelopes", () => {
  expect(formatRevertError({ _tag: "ConflictError", resource: "revert-plan", message: "changed" }, translate)).toBe(
    "session.revert.planChanged",
  )
  expect(
    formatRevertError(
      new Error("UnexpectedStatus", { cause: { body: { _tag: "ConflictError", resource: "revert-plan" } } }),
      translate,
    ),
  ).toBe("session.revert.planChanged")
  expect(
    formatRevertError({ _tag: "UnknownError", message: "Cannot undo report.txt: the file changed" }, translate),
  ).toContain("report.txt")
  expect(
    formatRevertError(
      new Error("UnexpectedStatus", { cause: { body: { _tag: "UnknownError", message: "file changed" } } }),
      translate,
    ),
  ).toBe("file changed")
  expect(formatRevertError(new Error("Network offline"), translate)).toContain("session.revert.restoreFailed")
  expect(formatRevertError(new Error("Network offline"), translate)).toContain("Network offline")
})
