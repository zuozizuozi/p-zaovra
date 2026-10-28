import { expect, test } from "bun:test"
import { Feedback } from "./feedback"

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
