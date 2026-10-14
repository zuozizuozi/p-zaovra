import { expect, test } from "bun:test"
import { notificationText } from "./notification-content"

test("notification bodies normalize multiline text and truncate without splitting emoji", () => {
  expect(notificationText("  Which\n option?  ")).toBe("Which option?")
  expect(notificationText("😀".repeat(200))).toBe("😀".repeat(159) + "…")
  expect(notificationText("A".repeat(160))).toHaveLength(160)
})
