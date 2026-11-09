import { expect, test } from "bun:test"
import { Feedback } from "./feedback"
import { redactionSamples } from "../test/fixtures/feedback-redaction"

test("776 explicitly supplied diagnostics survive the frozen report and copied feedback", () => {
  const snapshot = Feedback.snapshot({
    now: 0,
    description: "second turn failed",
    context: {
      errors: [
        {
          at: 0,
          status: 400,
          providerCode: "invalid_encrypted_content",
          providerMessage: "cipher rejected",
          providerMessageSource: "structured",
        },
      ],
    },
    include: { environment: false, events: false, errors: true },
  })
  expect(JSON.parse(snapshot.text).errors[0]).toMatchObject({
    status: 400,
    providerCode: "invalid_encrypted_content",
    providerMessage: "cipher rejected",
  })
  expect(Feedback.copy(snapshot)).toContain("invalid_encrypted_content")
  expect(Object.isFrozen(snapshot)).toBe(true)
  expect(Feedback.validSnapshot(snapshot)).toBe(true)
})

for (const sample of redactionSamples)
  test(`776 automatic provider diagnostic redacts ${sample.name}`, () => {
    const snapshot = Feedback.snapshot({
      now: 0,
      description: "",
      context: {
        errors: [
          { at: 0, providerCode: "bad_request", providerMessage: sample.text, providerMessageSource: "structured" },
        ],
      },
      include: { environment: false, events: false, errors: true },
    })
    expect(Feedback.copy(snapshot)).not.toContain(sample.marker)
    expect(JSON.parse(snapshot.text).errors[0].providerCode).toBe("bad_request")
  })

test("776 diagnostics are bounded, single line, and never inferred from legacy arbitrary text", () => {
  expect(Feedback.providerDiagnostic({ code: "x".repeat(97), message: "a".repeat(600), source: "structured" })).toEqual(
    {
      providerMessage: "a".repeat(512),
      providerMessageSource: "structured",
    },
  )
  expect(
    Feedback.providerDiagnostic({
      code: "sk-synthetic",
      message: "first\n\u202esecond\u0000third",
      source: "structured",
    }),
  ).toEqual({
    providerMessage: "first second third",
    providerMessageSource: "structured",
  })
  expect(Feedback.providerDiagnostic({ code: "https://synthetic.invalid/secret" })).toEqual({})
  const input = {
    now: 0,
    description: "",
    context: {
      errors: [{ at: 0, status: 400, message: "invalid_encrypted_content", diagnosticMessage: "private prose" }],
    },
    include: { environment: false, events: false, errors: true },
  }
  expect(JSON.parse(Feedback.snapshot(input).text).errors[0]).not.toHaveProperty("providerCode")
  expect(Feedback.copy(Feedback.snapshot(input))).not.toContain("private prose")
  expect(
    JSON.parse(Feedback.snapshot({ ...input, include: { ...input.include, errors: false } }).text),
  ).not.toHaveProperty("errors")
})
