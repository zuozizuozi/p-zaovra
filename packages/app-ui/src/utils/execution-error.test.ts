import { expect, test } from "bun:test"
import { explainExecutionError } from "./execution-error"
import { dict } from "../i18n/zh"

test("explains common execution failures in both languages without replacing redacted details", async () => {
  const english = await import("../i18n/en")
  for (const detail of [
    "HTTP 401: key <redacted> expired",
    "HTTP 402: insufficient balance",
    "HTTP 429: rate limit",
    "500 not implemented",
    "maximum context length",
    "ETIMEDOUT",
    "fetch failed",
    "HTTP 503",
  ]) {
    for (const dictionary of [dict, english.dict]) {
      const translated = explainExecutionError(detail, (key) => dictionary[key as keyof typeof dictionary])
      expect(translated).toEndWith(`\n\n${detail}`)
      expect(translated).not.toContain("undefined")
      expect(translated).not.toStartWith("error.execution.")
    }
  }
})

test("leaves unrecognized failures intact", () => {
  expect(explainExecutionError("custom tool rejected field x", () => "wrong")).toBe("custom tool rejected field x")
  expect(explainExecutionError("file.ts:401 failed assertion", () => "wrong")).toBe("file.ts:401 failed assertion")
})
