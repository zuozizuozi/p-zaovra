import { expect, test } from "bun:test"
import { BlobReader, TextWriter, ZipReader } from "@zip.js/zip.js"
import { Feedback } from "@zaovra-ai/schema/feedback"
import { feedbackArchive } from "./feedback"
import { redactionInputs, redactionSamples } from "../../../schema/test/fixtures/feedback-redaction"

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

for (const sample of redactionSamples) {
  for (const input of redactionInputs) {
    test(sample.name + " through " + input + " cannot survive the real ZIP text bytes", async () => {
      const snapshot = Feedback.snapshot({
        now: 0,
        description: "APPROVED_NOTE_409",
        context: {},
        include: { environment: true, events: true, errors: true },
        [input]: sample.text,
      })
      const reader = new ZipReader(new BlobReader(await feedbackArchive(snapshot)))
      try {
        const entries = await reader.getEntries()
        expect(entries.map((entry) => entry.filename)).toEqual(snapshot.files.map((file) => file.name))
        for (const entry of entries) {
          const text = await entry.getData!(new TextWriter())
          expect(text).toBe(snapshot.files.find((file) => file.name === entry.filename)!.text)
          expect(text).not.toContain(sample.marker)
        }
      } finally {
        await reader.close()
      }
      expect(Feedback.copy(snapshot)).not.toContain(sample.marker)
    })
  }
}
