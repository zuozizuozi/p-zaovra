import { expect, test } from "bun:test"
import { Feedback } from "./feedback"
import { credentialFields, redactionInputs, redactionSamples } from "../test/fixtures/feedback-redaction"

test("default automatic snapshot projects bounded fields and excludes free text and nested secrets", () => {
  const now = 1_000_000
  const secret = "SYNTHETIC_SECRET_BODY"
  const raw = {
    at: now,
    kind: "read",
    state: "error",
    args: { path: secret },
    output: secret,
    stack: secret,
    message: secret,
    url: `https://u:${secret}@example.test/?token=${secret}`,
    cookie: secret,
    env: { TOKEN: secret },
    filename: secret,
  }
  const snapshot = Feedback.snapshot({
    now,
    description: "",
    context: {
      version: secret,
      platform: secret,
      provider: secret,
      model: secret,
      events: [{ ...raw, at: 0 }, ...Array.from({ length: 60 }, () => raw)],
      errors: [raw],
    },
    include: { environment: true, events: true, errors: true },
  })
  expect(Feedback.copy(snapshot)).not.toContain(secret)
  expect(snapshot.files.map((file) => file.name)).toEqual(["report.json"])
  expect(JSON.parse(snapshot.text).events).toHaveLength(50)
  raw.kind = secret
  expect(JSON.parse(snapshot.text).events[0].kind).toBe("read")
  expect(Object.isFrozen(snapshot.files)).toBe(true)
})

test("deselected categories and opt-in text are absent; copies use the same frozen projection", () => {
  const snapshot = Feedback.snapshot({
    now: 0,
    description: "steps",
    context: { version: "0.1.0" },
    include: { environment: false, events: false, errors: false },
    details:
      "Authorization: Bearer sk-test123\nC:\\Users\\synthetic\\private.txt\ntoken=secret123 https://u:pw@example.test/private?q=secret123",
  })
  expect(snapshot.text).not.toContain("environment")
  expect(snapshot.text).not.toContain("events")
  const content = Feedback.copy(snapshot)
  for (const secret of ["sk-test123", "synthetic", "private.txt", "secret123", "u:pw", "?q="])
    expect(content).not.toContain(secret)
  expect(Feedback.validSnapshot(snapshot)).toBe(true)
  expect(Feedback.validSnapshot({ ...snapshot, files: [{ name: "../secret", text: "bad" }] })).toBe(false)
})

test("self check classifies suggestions without creating a submission gate or configuration mutation", () => {
  expect(["401", "429", "proxy failed", "unclassified"].map(Feedback.suggestion)).toEqual([
    "auth",
    "rate",
    "network",
    "unknown",
  ])
})

test("explicitly included JSON and code redact quoted nested credentials while preserving ordinary code", () => {
  const input =
    '{"token":"SYNTHETIC_JSON_SECRET","headers":{"Cookie":"SYNTHETIC_COOKIE_SECRET"},"apiKey":"SYNTHETIC_KEY_SECRET"}\nCUSTOM_PRIVATE="SYNTHETIC_ENV_SECRET"\nconst ordinary="APPROVED_CODE"'
  const snapshot = Feedback.snapshot({
    now: 0,
    context: {},
    description: "",
    include: { environment: false, events: false, errors: false },
    code: input,
  })
  const code = snapshot.files.find((file) => file.name === "code.txt")!.text
  for (const secret of [
    "SYNTHETIC_JSON_SECRET",
    "SYNTHETIC_COOKIE_SECRET",
    "SYNTHETIC_KEY_SECRET",
    "SYNTHETIC_ENV_SECRET",
  ])
    expect(code).not.toContain(secret)
  expect(code).toContain("APPROVED_CODE")
  expect(Feedback.redact('escaped: {\\"token\\":\\"SYNTHETIC_ESCAPED_SECRET\\"}')).not.toContain(
    "SYNTHETIC_ESCAPED_SECRET",
  )
})

for (const sample of redactionSamples) {
  for (const input of redactionInputs) {
    test(sample.name + " is removed from the frozen " + input + " snapshot and copied text", () => {
      const snapshot = Feedback.snapshot({
        now: 0,
        context: {},
        include: { environment: true, events: true, errors: true },
        description: "APPROVED_NOTE_409",
        [input]: sample.text,
      })
      expect(snapshot.text).not.toContain(sample.marker)
      expect(Feedback.copy(snapshot)).not.toContain(sample.marker)
      expect(Feedback.copy(snapshot)).toContain("APPROVED_NOTE_409")
      for (const text of sample.preserve) expect(Feedback.copy(snapshot)).toContain(text)
      expect(Object.isFrozen(snapshot)).toBe(true)
      expect(Feedback.validSnapshot(snapshot)).toBe(true)
    })
  }
}
test("credential keys and separator/case variants recursively replace their whole JSON value", () => {
  for (const field of credentialFields) {
    const camel = field.replace(/_([a-z])/g, (_match, value: string) => value.toUpperCase())
    for (const key of [field, field.replaceAll("_", "-"), field.toUpperCase(), camel]) {
      const json = JSON.stringify({
        message: "ordinary text",
        nested: [{ [key]: { tokenValue: ["SENTINEL_VARIANT_409"] } }],
      })
      const result = Feedback.redact(json)
      expect(result).not.toContain("SENTINEL_VARIANT_409")
      expect(JSON.parse(result).message).toBe("ordinary text")
    }
  }
})
test("malformed and escaped JSON still receive conservative credential text redaction", () => {
  for (const sample of redactionSamples) {
    for (const text of [
      sample.text + " trailing prose",
      sample.text.slice(0, -1),
      "escaped: " + sample.text.replaceAll('"', '\\"'),
    ])
      expect(Feedback.redact(text)).not.toContain(sample.marker)
  }
  expect(Feedback.redact('password="prefix\\"SENTINEL_TEXT_409\\"tail"\nordinary text')).not.toContain(
    "SENTINEL_TEXT_409",
  )
  expect(Feedback.redact('private-key="line one\nSENTINEL_MULTILINE_409\nline three"\nordinary text')).not.toContain(
    "SENTINEL_MULTILINE_409",
  )
  expect(Feedback.redact('{"\\u0061ccess_token":"SENTINEL_UNICODE_409"}')).not.toContain("SENTINEL_UNICODE_409")
})
test("ordinary text survives and truncation/deep JSON cannot expose a credential suffix", () => {
  const ordinary = '用户点击后没有响应。Password reset failed; tokenization is normal.\nconst ordinary="APPROVED_CODE"'
  expect(Feedback.redact(ordinary)).toBe(ordinary)
  const json = JSON.stringify({ title: "普通说明", data: ['safe quoted \\" text', 7, false, null] })
  expect(JSON.parse(Feedback.redact(json))).toEqual(JSON.parse(json))
  expect(Feedback.redact('{"access_token":"SENTINEL_LONG_409' + "x".repeat(40_000))).not.toContain("SENTINEL_LONG_409")
  expect(Feedback.redact("[".repeat(150) + '{"private_key":"SENTINEL_DEEP_409"}' + "]".repeat(150))).not.toContain(
    "SENTINEL_DEEP_409",
  )
})

test("diagnostic colon lines survive while environment assignments remain private", () => {
  for (const line of [
    "ERROR: request failed with status 503; retry after 30 seconds",
    "ENOENT: required file missing",
    "HTTP 503: service unavailable",
  ]) {
    expect(Feedback.redact(line)).toBe(line)
    const text = Feedback.redact('CUSTOM_PRIVATE="SENTINEL_ENV_410"\n' + line)
    expect(text).not.toContain("SENTINEL_ENV_410")
    expect(text).toContain(line)
  }
})
test("paired credential ranges preserve the following reproduction and expected result", () => {
  const suffix = "\nReproduction: click export twice\nExpected: archive saved"
  for (const value of [
    "[one,two]",
    '{"nested":["one",{"value":"SENTINEL_PAIRED_410 and ] } )"}]}',
    '("SENTINEL_PAIRED_410 and )", [one,two])',
    '"prefix\\"SENTINEL_PAIRED_410\\"suffix"',
    "'prefix\\'SENTINEL_PAIRED_410\\'suffix'",
    '["SENTINEL_PAIRED_410",\n{"nested":["quoted \\" ] still a value"]}]',
  ]) {
    const text = Feedback.redact("token=" + value + suffix)
    expect(text).not.toContain("SENTINEL_PAIRED_410")
    expect(text).not.toContain("one,two")
    expect(text).toContain(suffix)
  }
  // An unterminated structured credential has no safe end: omit its remainder.
  expect(Feedback.redact('token=[one,\n"SENTINEL_UNTERMINATED_410"')).not.toContain("SENTINEL_UNTERMINATED_410")
})
