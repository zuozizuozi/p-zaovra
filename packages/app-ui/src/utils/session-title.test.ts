import { expect, test } from "bun:test"
import { sessionTitle } from "./session-title"

const language = {
  intl: () => "zh-CN",
  t: (key: "command.session.new" | "session.title.child") => (key === "command.session.new" ? "新对话" : "子对话"),
}

test("formats only generated fallback titles in the user's locale and local timezone", () => {
  const stamp = "2026-10-12T05:55:00.000Z"
  const date = new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(stamp))
  expect(sessionTitle(`New session - ${stamp}`, language)).toBe(`新对话 ${date}`)
  expect(sessionTitle(`Child session - ${stamp}`, language)).toBe(`子对话 ${date}`)
})

test("preserves first prompts, renamed titles, missing titles and invalid dates", () => {
  for (const title of [
    undefined,
    "",
    "修好搜索功能",
    "New session - my task",
    "New session - 2026-99-12T05:55:00.000Z",
  ])
    expect(sessionTitle(title, language)).toBe(title)
})
