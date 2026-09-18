import { expect, test } from "bun:test"
import { requestShape, usageNumbers } from "../src/route/diagnostics"

test("request diagnostics record only numeric output limits from the final wire body", () => {
  const body = {
    max_tokens: 32000,
    max_output_tokens: "secret",
    generationConfig: { maxOutputTokens: 16000, key: "secret" },
  }
  const shape = requestShape(body, JSON.stringify(body))
  expect(shape.outputLimits).toEqual({ max_tokens: 32000, "generationConfig.maxOutputTokens": 16000 })
  expect(JSON.stringify(shape)).not.toContain("secret")
})

test("request diagnostics detect earlier message edits without exposing content", () => {
  const body = {
    messages: [
      { role: "system", content: "private instructions" },
      { role: "user", content: "private code" },
    ],
    tools: [{ name: "read" }],
  }
  const first = requestShape(body, JSON.stringify(body))
  const next = { ...body, messages: [...body.messages, { role: "assistant", content: "result" }] }
  const second = requestShape(next, JSON.stringify(next))
  expect(second.messageHashes.slice(0, 2)).toEqual(first.messageHashes)
  expect(second.systemHash).toBe(first.systemHash)
  expect(second.toolsHash).toBe(first.toolsHash)
  expect(second.bodyHash).not.toBe(first.bodyHash)
  const changed = { ...body, messages: [{ role: "system", content: "different" }, body.messages[1]] }
  expect(requestShape(changed, JSON.stringify(changed)).systemHash).not.toBe(first.systemHash)
  expect(JSON.stringify(first)).not.toContain("private")
})

test("usage diagnostics preserve numeric counters and exclude secrets and arbitrary metadata", () => {
  expect(
    usageNumbers({
      openai: {
        prompt_tokens: 10,
        prompt_tokens_details: { cached_tokens: 4, secret: "key" },
        completion_tokens: 3,
        authorization: "key",
        model: "private",
      },
      secret: 12,
    }),
  ).toEqual({ openai: { prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 4 }, completion_tokens: 3 } })
})
