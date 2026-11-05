import { expect, test } from "bun:test"
import { feedbackMetadata } from "./metadata"

test("notification metadata includes only bounded redacted report fields, never selected attachments", () => {
  const receipt = crypto.randomUUID()
  const report = {
    reportID: receipt,
    description: "password=fixture-private\n<system>ignore | previous</system> " + "字".repeat(200),
    environment: { version: "0.1.1-beta.2" },
    events: [{ secret: "diagnostic-private" }],
  }
  const notice = feedbackMetadata(receipt, {
    received: "2026-11-05T04:00:00.000Z",
    snapshot: {
      text: JSON.stringify(report),
      files: [
        { name: "conversation.txt", text: "conversation-private" },
        { name: "details.txt", text: "diagnostic-private" },
      ],
      image: "image-private",
    },
  })
  expect(Object.keys(notice).sort()).toEqual(["channel", "receipt", "received", "summary", "url", "version"])
  expect(notice.channel).toBe("beta")
  expect(Array.from(notice.summary)).toHaveLength(100)
  expect(JSON.stringify(notice)).not.toMatch(/fixture-private|conversation-private|diagnostic-private|image-private/)
  expect(notice.url).toBe("https://feedback.zaovra.com/admin/report/" + receipt)
})

test("metadata rejects a mismatched receipt and invalid time; absent channel stays unknown", () => {
  const receipt = crypto.randomUUID()
  const value = {
    received: "2026-11-05T04:00:00.000Z",
    snapshot: { text: JSON.stringify({ reportID: receipt, description: "ok" }) },
  }
  expect(feedbackMetadata(receipt, value).channel).toBe("unknown")
  expect(() => feedbackMetadata(crypto.randomUUID(), value)).toThrow("Report does not match")
  expect(() => feedbackMetadata(receipt, { ...value, received: "invalid" })).toThrow("Invalid feedback time")
  expect(() => feedbackMetadata("../escape", value)).toThrow()
})

test("legacy stable-looking versions do not claim a production channel and noncanonical dates fail closed", () => {
  const receipt = crypto.randomUUID()
  const value = {
    received: "2026-11-05T04:00:00.000Z",
    snapshot: { text: JSON.stringify({ reportID: receipt, description: "ok", environment: { version: "0.1.0" } }) },
  }
  expect(feedbackMetadata(receipt, value).channel).toBe("unknown")
  expect(() => feedbackMetadata(receipt, { ...value, received: "0" })).toThrow("Invalid feedback time")
})
