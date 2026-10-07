import { expect, test } from "bun:test"
import { cleanupEmptyDrafts, isEmptyDraftPrompt } from "./empty-drafts"

const empty = { prompt: [{ type: "text", content: "", start: 0, end: 0 }], context: { items: [] } }

test("only known empty prompts qualify", () => {
  expect(isEmptyDraftPrompt(null)).toBe(true)
  expect(isEmptyDraftPrompt(JSON.stringify(empty))).toBe(true)
  for (const value of ["{", "null", "{}", "[]", JSON.stringify({ prompt: [] })]) {
    expect(isEmptyDraftPrompt(value)).toBe(false)
  }
})

test("text, whitespace, images, files, agent references and context are preserved", () => {
  for (const part of [
    { type: "text", content: "task" },
    { type: "text", content: " " },
    { type: "image", dataUrl: "data:image/png;base64,example" },
    { type: "file", path: "task.ts", content: "" },
    { type: "agent", name: "build", content: "" },
    { type: "future-part", content: "" },
  ])
    expect(isEmptyDraftPrompt(JSON.stringify({ ...empty, prompt: [part] }))).toBe(false)
  expect(isEmptyDraftPrompt(JSON.stringify({ ...empty, context: { items: [{ path: "task.ts" }] } }))).toBe(false)
})

test("failed reads preserve their tab while independent empty tabs are cleaned", async () => {
  const removed: string[] = []
  await cleanupEmptyDrafts({
    ids: ["empty", "failure", "malformed", "text"],
    read: async (id) => {
      if (id === "failure") throw new Error("disk unavailable")
      if (id === "malformed") return "{"
      if (id === "text") return JSON.stringify({ ...empty, prompt: [{ type: "text", content: "keep" }] })
      return JSON.stringify(empty)
    },
    canRemove: () => true,
    remove: (id) => removed.push(id),
  })
  expect(removed).toEqual(["empty"])
})

test("rechecks live ownership after asynchronous reads", async () => {
  const removed: string[] = []
  const live = new Set(["empty", "typing", "promoted", "active", "unmounted"])
  const reading = Promise.withResolvers<string | null>()
  const pending = cleanupEmptyDrafts({
    ids: [...live],
    read: () => reading.promise,
    canRemove: (id) => live.has(id),
    remove: (id) => removed.push(id),
  })
  for (const id of ["typing", "promoted", "active", "unmounted"]) live.delete(id)
  reading.resolve(JSON.stringify(empty))
  await pending
  expect(removed).toEqual(["empty"])
})
