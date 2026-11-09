import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClientRequest } from "effect/unstable/http"
import { LLMError, InvalidRequestReason } from "@zaovra-ai/llm"
import { RequestExecutor } from "@zaovra-ai/llm/route"
import { Feedback } from "@zaovra-ai/schema/feedback"
import { ProviderDiagnostics } from "../src/session/provider-diagnostics"
import { dynamicResponse } from "../../llm/test/lib/http"
import { testEffect } from "./lib/effect"

const cases = [
  { name: "plain short body", body: "PRIVATE_PLAIN_791", marker: "PRIVATE_PLAIN_791" },
  { name: "HTML body", body: "<html>PRIVATE_HTML_791</html>", marker: "PRIVATE_HTML_791" },
  {
    name: "JSON without a structured message",
    body: JSON.stringify({ error: { code: "bad_request", payload: "PRIVATE_JSON_791" } }),
    marker: "PRIVATE_JSON_791",
    code: "bad_request",
  },
  { name: "long truncated body", body: "PRIVATE_LONG_791".repeat(2000), marker: "PRIVATE_LONG_791" },
  { name: "empty body", body: "", marker: "PRIVATE_EMPTY_791" },
  {
    name: "structured message and remedy with private unrelated fields",
    body: JSON.stringify({
      error: {
        code: "invalid_encrypted_content",
        message: "cipher rejected",
        remedy_hint: "start a new turn",
        payload: "PRIVATE_FIELD_791",
      },
    }),
    marker: "PRIVATE_FIELD_791",
    code: "invalid_encrypted_content",
    summary: "cipher rejected; start a new turn",
  },
  {
    name: "escaped credentials in a structured summary",
    body: JSON.stringify({ message: 'rejected; api_key="SYNTHETIC_SECRET_791"' }),
    marker: "SYNTHETIC_SECRET_791",
    summary: "rejected",
  },
] as const

for (const sample of cases)
  testEffect(Layer.empty).effect(`791 default feedback isolates ${sample.name}`, () =>
    Effect.gen(function* () {
      const error = yield* RequestExecutor.Service.use((executor) =>
        executor.execute(HttpClientRequest.post("https://synthetic.invalid/responses")),
      ).pipe(
        Effect.provide(
          dynamicResponse(({ respond }) =>
            Effect.sync(() =>
              respond(sample.body, {
                status: 400,
                headers: { "x-request-id": "req_791" },
              }),
            ),
          ),
        ),
        Effect.provideService(RequestExecutor.AutomaticRetries, false),
        Effect.flip,
      )
      const diagnostic = ProviderDiagnostics.metadata(error)
      const snapshot = Feedback.snapshot({
        now: 1,
        description: "",
        context: { errors: [{ at: 1, status: 400, ...diagnostic }] },
        include: { environment: false, events: false, errors: true },
      })
      const report = JSON.parse(snapshot.text).errors[0]
      expect(report.status).toBe(400)
      expect(report.requestID).toBe("req_791")
      expect(report.providerCode).toBe("code" in sample ? sample.code : undefined)
      expect(Feedback.copy(snapshot)).not.toContain(sample.marker)
      expect(snapshot.files.map((file) => file.name)).toEqual(["report.json"])
      if ("summary" in sample) {
        expect(report.providerMessage).toContain(sample.summary)
        expect(diagnostic.providerMessageSource).toBe("structured")
        return
      }
      expect(report).not.toHaveProperty("providerMessage")
      expect(diagnostic).not.toHaveProperty("providerMessage")
      const details = Feedback.snapshot({
        now: 1,
        description: "",
        context: {},
        include: { environment: false, events: false, errors: true },
        details: "http" in error.reason ? error.reason.http?.body : undefined,
      })
      expect(details.text).not.toContain(sample.marker)
      expect(details.files.find((file) => file.name === "details.txt")?.text ?? "").toContain(
        Feedback.redact(sample.body).slice(0, 100),
      )
    }),
  )

test("791 old or unproven summary origins are excluded at the final report boundary", () => {
  for (const source of [undefined, "body", "status"]) {
    const snapshot = Feedback.snapshot({
      now: 1,
      description: "",
      context: {
        errors: [
          {
            at: 1,
            status: 400,
            providerCode: "bad_request",
            requestID: "req_old",
            providerMessage: "PRIVATE_OLD_BODY_791",
            providerMessageSource: source,
          },
        ],
      },
      include: { environment: false, events: false, errors: true },
    })
    expect(snapshot.text).not.toContain("PRIVATE_OLD_BODY_791")
    expect(JSON.parse(snapshot.text).errors[0]).toMatchObject({
      status: 400,
      providerCode: "bad_request",
      requestID: "req_old",
    })
  }
  expect(
    ProviderDiagnostics.metadata(
      new LLMError({
        module: "Legacy",
        method: "request",
        reason: new InvalidRequestReason({
          message: "PRIVATE_UNPROVEN_791",
          providerMetadata: { diagnostic: { code: "bad_request" } },
        }),
      }),
    ),
  ).not.toHaveProperty("providerMessage")
})
