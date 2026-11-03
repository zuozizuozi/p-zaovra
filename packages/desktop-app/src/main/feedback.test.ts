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
      for (const text of sample.preserve) expect(Feedback.copy(snapshot)).toContain(text)
    })
  }
}

test("real HTTP submission returns only a validated receipt and rejects offline, oversized and false acknowledgments", async () => {
  const { submitFeedback } = await import("./feedback")
  const snapshot = Feedback.snapshot({ now: Date.now(), description: "synthetic feedback", context: {}, include: {} })
  const receipt = JSON.parse(snapshot.files.find((file) => file.name === "report.json")!.text).reportID as string
  let mode = "ok"
  let posted: unknown
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      posted = await request.json()
      if (mode === "offline") return new Response("unavailable", { status: 503 })
      if (mode === "large") return new Response("x".repeat(2049))
      return Response.json({ submitted: mode !== "false", receipt })
    },
  })
  const fetcher = (url: string, init?: RequestInit) => {
    expect(url).toBe("https://feedback.zaovra.com/v1/feedback")
    expect(init?.redirect).toBe("error")
    return fetch(server.url, init)
  }
  try {
    expect(await submitFeedback(snapshot, fetcher)).toEqual({ submitted: true, receipt })
    expect(posted).toEqual(snapshot)
    for (mode of ["offline", "large", "false"]) await expect(submitFeedback(snapshot, fetcher)).rejects.toThrow()
  } finally {
    await server.stop(true)
  }
})
