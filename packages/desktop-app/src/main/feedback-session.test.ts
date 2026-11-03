import { expect, test } from "bun:test"
import { BlobReader, TextWriter, ZipReader } from "@zip.js/zip.js"
import type { AssistantMessage } from "@zaovra-ai/sdk/v2"
import { Feedback } from "@zaovra-ai/schema/feedback"
import { sessionFeedback } from "../../../app-ui/src/components/feedback-session"
import { feedbackArchive } from "./feedback"

test("549 first-message API failure reaches actual diagnostic ZIP with status, redacted message and request id", async () => {
  const message: AssistantMessage = {
    id: "msg_400",
    sessionID: "ses_549",
    role: "assistant",
    parentID: "msg_user",
    agent: "build",
    mode: "build",
    modelID: "fixture",
    providerID: "fixture",
    time: { created: 100, completed: 101 },
    path: { cwd: "/fixture", root: "/fixture" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    error: {
      name: "APIError",
      data: {
        statusCode: 400,
        isRetryable: false,
        message: "HTTP 400 invalid tool schema",
        responseHeaders: { "x-request-id": "req_fixture_549", authorization: "Bearer SECRET_HEADER" },
        responseBody: "PRIVATE_BODY",
      },
    },
  }
  const context = sessionFeedback([message], () => [], 101).context
  const snapshot = Feedback.snapshot({
    now: 101,
    description: "first request failed",
    context,
    include: { environment: true, errors: true, events: true },
  })
  const zip = new ZipReader(new BlobReader(await feedbackArchive(snapshot)))
  try {
    const entries = await zip.getEntries()
    expect(entries.map((entry) => entry.filename)).toEqual(["report.json"])
    const text = await entries[0].getData!(new TextWriter())
    expect(text).toBe(snapshot.text)
    const report = JSON.parse(text)
    expect(report.errors).toEqual([
      {
        at: new Date(101).toISOString(),
        secondsAgo: 0,
        status: 400,
        category: "unknown",
        message: "HTTP 400 invalid tool schema",
        requestID: "req_fixture_549",
      },
    ])
    expect(report.events).toEqual([{ at: new Date(101).toISOString(), secondsAgo: 0, kind: "message", state: "error" }])
    expect(text).not.toContain("SECRET_HEADER")
    expect(text).not.toContain("PRIVATE_BODY")
  } finally {
    await zip.close()
  }
})
