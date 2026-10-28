import { expect, test } from "bun:test"
import { BlobReader, TextWriter, ZipReader } from "@zip.js/zip.js"
import { Feedback } from "@zaovra-ai/schema/feedback"
import { feedbackArchive } from "./feedback"

test("actual exported zip contains only the frozen preview, never raw logs or deselected items", async () => {
  const secret = "SYNTHETIC_SECRET_BODY"
  const context = {
    events: [{ at: 1000, kind: "read", state: "error", args: secret, message: secret, filename: secret }],
  }
  const snapshot = Feedback.snapshot({
    now: 1000,
    description: "reproduce",
    context,
    include: { environment: false, events: true, errors: false },
  })
  context.events[0].kind = secret
  const reader = new ZipReader(new BlobReader(await feedbackArchive(snapshot)))
  const entries = await reader.getEntries()
  expect(entries.map((entry) => entry.filename)).toEqual(["report.json"])
  for (const entry of entries) {
    const text = await entry.getData!(new TextWriter())
    expect(text).toBe(snapshot.text)
    expect(text).not.toContain(secret)
    expect(text).not.toContain("environment")
  }
  await reader.close()
})
