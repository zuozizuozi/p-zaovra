import { expect, test } from "bun:test"
import path from "node:path"
import { observeUsage } from "../../../../script/evaluation/memory/usage"
import { startEvaluationRelay } from "../../../../script/evaluation/memory/relay"
import { tmpdir } from "../fixture/fixture"

const bytes = (value: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(value)}\r\n\r\n`)
const terminal = (protocol: "openai-chat" | "openai-responses", total = 15) =>
  protocol === "openai-chat"
    ? {
        choices: [],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: total, prompt_cache_hit_tokens: 8 },
      }
    : {
        type: "response.completed",
        response: {
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            total_tokens: total,
            input_tokens_details: { cached_tokens: 8 },
            output_tokens_details: { reasoning_tokens: 3 },
          },
        },
      }

for (const protocol of ["openai-chat", "openai-responses"] as const) {
  test(`numeric usage handles every byte boundary and inclusive breakdowns: ${protocol}`, () => {
    const observer = observeUsage(protocol)
    for (const value of bytes(terminal(protocol))) observer.feed(Uint8Array.of(value))
    expect(observer.result()).toEqual({
      status: "reported",
      input: 10,
      output: 5,
      total: 15,
      basis: "provider-terminal-usage",
    })
    observer.feed(bytes(terminal(protocol)))
    expect(observer.result()).toMatchObject({ status: "reported", total: 15 })
  })
  test(`inconsistent totals remain unknown: ${protocol}`, () => {
    const observer = observeUsage(protocol)
    observer.feed(bytes(terminal(protocol, 16)))
    expect(observer.result()).toEqual({ status: "unknown", reason: "invalid-usage" })
  })
  test(`missing, unfinished and malformed frames remain unknown: ${protocol}`, () => {
    const observer = observeUsage(protocol)
    observer.feed(
      bytes({
        type: "response.output_text.delta",
        delta: "private response text",
        choices: [{ delta: { content: "secret" }, finish_reason: null }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    )
    expect(observer.result()).toEqual({ status: "unknown", reason: "no-terminal-usage" })
    observer.feed(bytes(terminal(protocol)).slice(0, -4))
    expect(observer.result().status).toBe("unknown")
    const invalid = observeUsage(protocol)
    invalid.feed(new TextEncoder().encode("data: not-json\n\n"))
    invalid.feed(bytes(terminal(protocol)))
    expect(invalid.result()).toEqual({ status: "unknown", reason: "invalid-frame" })
  })
}

test("conflicting terminal usage and unsafe values never become a settled total", () => {
  const observer = observeUsage("openai-chat")
  observer.feed(bytes(terminal("openai-chat")))
  observer.feed(bytes({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 } }))
  expect(observer.result()).toEqual({ status: "unknown", reason: "conflicting-usage" })
  for (const input of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, "10"]) {
    const invalid = observeUsage("openai-chat")
    invalid.feed(bytes({ choices: [], usage: { prompt_tokens: input, completion_tokens: 5 } }))
    expect(invalid.result()).toEqual({ status: "unknown", reason: "invalid-usage" })
  }
})

test("real relay binds numeric usage to physical admission and leaves response bytes unchanged", async () => {
  await using tmp = await tmpdir()
  const payload =
    `data: ${JSON.stringify({ choices: [{ delta: { content: "private response text" }, finish_reason: null }] })}\n\n` +
    new TextDecoder().decode(bytes(terminal("openai-chat"))) +
    "data: [DONE]\n\n"
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(payload, { headers: { "content-type": "text/event-stream" } }),
  })
  const journal = path.join(tmp.path, "numeric.jsonl")
  const relay = startEvaluationRelay({
    baseURL: `http://127.0.0.1:${upstream.port}/v1`,
    apiKey: "private-test-key",
    model: "fixture",
    protocol: "openai-chat",
    journal,
    maxRequests: 1,
    maxRequestBytes: 4096,
    maxOutput: 64,
  })
  try {
    const response = await fetch(relay.baseURL + "/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${relay.apiKey}` },
      body: JSON.stringify({
        model: "fixture",
        stream: true,
        max_tokens: 64,
        messages: [{ role: "user", content: "hello" }],
      }),
    })
    expect(await response.text()).toBe(payload)
  } finally {
    await relay.stop()
    await upstream.stop(true)
  }
  const text = await Bun.file(journal).text()
  const records = text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
  const admitted = records.filter((record) => record.phase === "admitted")
  expect(admitted).toHaveLength(1)
  expect(records.filter((record) => record.phase === "usage-observed")).toEqual([
    {
      id: admitted[0].id,
      phase: "usage-observed",
      end: "eof",
      status: "reported",
      input: 10,
      output: 5,
      total: 15,
      basis: "provider-terminal-usage",
    },
  ])
  expect(text).not.toContain("private response text")
  expect(text).not.toContain("private-test-key")
})
