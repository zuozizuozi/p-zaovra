import { expect, test } from "bun:test"
import { SessionCompaction } from "@zaovra-ai/core/session/compaction"

test("compaction preserves structured-only read results and does not duplicate rendered output", () => {
  const structured = { type: "text-page", content: "const answer = 42", offset: 1, next: 2 }
  expect(SessionCompaction.serializeToolContent([], structured)).toContain("const answer = 42")
  expect(SessionCompaction.serializeToolContent([{ type: "text", text: "bounded preview" }], structured)).toBe(
    "bounded preview",
  )
})

test("compaction prompt preserves detailed work state and relevant files", () => {
  const prompt = SessionCompaction.buildPrompt({ context: ["conversation history"] })

  expect(prompt).toContain("## Work State\n### Completed")
  expect(prompt).toContain("### Active")
  expect(prompt).toContain("### Blocked")
  expect(prompt).toContain("## Relevant Files")
})

test("compaction describes tool media without embedding base64", () => {
  const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"
  const serialized = SessionCompaction.serializeToolContent([
    { type: "text", text: "Image read successfully" },
    {
      type: "file",
      uri: `data:image/png;base64,${base64}`,
      mime: "image/png",
      name: "pixel.png",
    },
  ])

  expect(serialized).toBe("Image read successfully\n[Attached image/png: pixel.png]")
  expect(serialized).not.toContain(base64)
})
