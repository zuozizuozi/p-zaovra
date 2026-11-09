import { expect, test } from "bun:test"
import type { Message } from "@zaovra-ai/sdk/v2"
import { Feedback } from "@zaovra-ai/schema/feedback"
import { sessionFeedback } from "./feedback-session"

const assistant = {
  id: "msg_synthetic",
  sessionID: "ses_synthetic",
  role: "assistant",
  time: { created: 0, completed: 1 },
  parentID: "msg_user",
  modelID: "gpt-synthetic",
  providerID: "synthetic-provider",
  mode: "build",
  agent: "build",
  path: { cwd: "/synthetic", root: "/synthetic" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
} satisfies Message

test("776 API diagnostics reach automatic feedback without raw API bodies or headers", () => {
  const result = sessionFeedback(
    [
      {
        ...assistant,
        error: {
          name: "APIError",
          data: {
            message: "服务无法处理这次请求。",
            isRetryable: false,
            statusCode: 400,
            metadata: {
              providerCode: "invalid_encrypted_content",
              providerMessageSource: "structured",
              providerMessage: 'cipher rejected; api_key="SYNTHETIC_SECRET_776"',
              requestID: "req_synthetic",
              responseBody: "UNSELECTED_BODY_776",
            },
            responseHeaders: { authorization: "UNSELECTED_HEADER_776" },
            responseBody: "UNSELECTED_BODY_776",
          },
        },
      },
    ],
    () => [],
    1,
  )
  const snapshot = Feedback.snapshot({
    now: 1,
    description: "second turn",
    context: result.context,
    include: { environment: false, events: false, errors: true },
  })
  expect(JSON.parse(snapshot.text).errors[0]).toMatchObject({
    status: 400,
    providerCode: "invalid_encrypted_content",
    providerMessage: expect.stringContaining("cipher rejected"),
    requestID: "req_synthetic",
  })
  for (const secret of ["SYNTHETIC_SECRET_776", "UNSELECTED_BODY_776", "UNSELECTED_HEADER_776"])
    expect(Feedback.copy(snapshot)).not.toContain(secret)
})

test("776 a historical bare 400 remains unknown instead of being relabelled as encrypted content", () => {
  const result = sessionFeedback(
    [{ ...assistant, error: { name: "APIError", data: { message: "HTTP 400", statusCode: 400, isRetryable: false } } }],
    () => [],
    1,
  )
  expect(result.context.errors[0]).toMatchObject({ status: 400, category: "unknown" })
  expect(result.context.errors[0]).not.toHaveProperty("providerCode")
  expect(result.context.errors[0]).not.toHaveProperty("providerMessage")
})

test("791 stored body or unknown source cannot re-enter default feedback through the UI collector", () => {
  for (const source of [undefined, "body", "status"]) {
    const result = sessionFeedback(
      [
        {
          ...assistant,
          error: {
            name: "APIError",
            data: {
              message: "服务无法处理这次请求。",
              statusCode: 400,
              isRetryable: false,
              metadata: {
                providerCode: "bad_request",
                requestID: "req_791",
                providerMessage: "PRIVATE_STORED_BODY_791",
                ...(source ? { providerMessageSource: source } : {}),
              },
            },
          },
        },
      ],
      () => [],
      1,
    )
    expect(result.context.errors[0]).toMatchObject({ status: 400, providerCode: "bad_request", requestID: "req_791" })
    expect(result.context.errors[0]).not.toHaveProperty("providerMessage")
    expect(
      Feedback.copy(
        Feedback.snapshot({
          now: 1,
          description: "",
          context: result.context,
          include: { environment: false, events: false, errors: true },
        }),
      ),
    ).not.toContain("PRIVATE_STORED_BODY_791")
  }
})
