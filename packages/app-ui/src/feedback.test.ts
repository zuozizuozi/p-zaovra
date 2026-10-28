import { expect, test } from "bun:test"
import { feedbackSlash } from "./feedback"
test("only a standalone /bug command opens feedback; quotations, code fences, longer commands and multiline prompts do not", () => {
  expect(feedbackSlash("/bug")).toBe("")
  expect(feedbackSlash("/bug describe it")).toBe("describe it")
  for (const text of ["/buggy", "`/bug`", "> /bug", "```\n/bug\n```", "/bug\nwrite code"])
    expect(feedbackSlash(text)).toBeUndefined()
})
