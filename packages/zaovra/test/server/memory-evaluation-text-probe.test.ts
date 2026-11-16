import { expect, test } from "bun:test"
import path from "node:path"
import { probeEvaluationText } from "../../../../script/evaluation/memory/text-probe"
import { tmpdir } from "../fixture/fixture"

const event = (value: unknown) => `data: ${JSON.stringify(value)}\r\n\r\n`
const chat =
  event({ choices: [{ index: 0, delta: { content: "READY" }, finish_reason: "stop" }] }) +
  event({
    choices: [],
    usage: { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9, private_error: "private-payload" },
  }) +
  "data: [DONE]\r\n\r\n"
const completed = {
  type: "response.completed",
  response: {
    status: "completed",
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "READY" }] }],
    usage: { input_tokens: 8, output_tokens: 1, total_tokens: 9, private_error: "private-payload" },
  },
}

for (const protocol of ["openai-chat", "openai-responses"] as const)
  test(`synthetic ${protocol} probe sends once, without tools, with explicit output ceiling and redacted evidence`, async () => {
    await using tmp = await tmpdir()
    const requests: { url: string; auth: string | null; body: Record<string, unknown> }[] = []
    const provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        requests.push({
          url: request.url,
          auth: request.headers.get("authorization"),
          body: (await request.json()) as Record<string, unknown>,
        })
        return new Response(protocol === "openai-chat" ? chat : event(completed), {
          headers: { "content-type": "text/event-stream", "x-private": "private-payload" },
        })
      },
    })
    const input = {
      baseURL: `http://127.0.0.1:${provider.port}/v1`,
      apiKey: "private-test-key",
      model: "fixture-model",
      protocol,
      journal: path.join(tmp.path, "relay.jsonl"),
    }
    try {
      const result = await probeEvaluationText(input)
      expect(result.pass).toBe(true)
      expect(result.reason).toBe("expected-text-matched")
      expect(result.responseModels).toEqual([])
      expect(result.responseModelStatus).toBe("not-reported")
      expect(result.usage.status).toBe("unsettled")
      expect(result.usage.reserve).toBe("retain")
      expect(result.usage.observations).toHaveLength(1)
      expect(result.usage.observations[0]?.total_tokens).toBe(9)
      expect(requests).toHaveLength(1)
      expect(requests[0]!.auth).toBe("Bearer private-test-key")
      expect(requests[0]!.body).toEqual(
        protocol === "openai-chat"
          ? {
              model: "fixture-model",
              stream: true,
              messages: [{ role: "user", content: "Reply with exactly READY." }],
              max_tokens: 256,
              stream_options: { include_usage: true },
            }
          : {
              model: "fixture-model",
              stream: true,
              input: [
                { type: "message", role: "user", content: [{ type: "input_text", text: "Reply with exactly READY." }] },
              ],
              max_output_tokens: 256,
            },
      )
      expect(result.request.bytes).toBeLessThan(4096)
      expect(JSON.stringify(result)).not.toContain("private-")
      const journal = await Bun.file(input.journal).text()
      expect(journal).not.toContain("private-")
      expect(journal).not.toContain("READY")
      expect(journal.split("\n").filter((line) => line.includes('"phase":"admitted"'))).toHaveLength(1)
      await expect(probeEvaluationText(input)).rejects.toThrow()
      expect(requests).toHaveLength(1)
    } finally {
      await provider.stop(true)
    }
  })

for (const protocol of ["openai-chat", "openai-responses"] as const)
  test(`synthetic ${protocol} probe separates response labels from text success`, async () => {
    await using tmp = await tmpdir()
    const scenarios = [
      { models: ["fixture-model"], labels: ["fixture-model"], status: "reported-label" },
      { models: ["other-model"], labels: ["other-model"], status: "reported-label" },
      { models: ["fixture-model", "fixture-model"], labels: ["fixture-model"], status: "reported-label" },
      {
        models: ["fixture-model", "other-model"],
        labels: ["fixture-model", "other-model"],
        status: "conflicting-labels",
      },
      { models: [123], labels: [], status: "invalid-label" },
      { models: ["private-test-key"], labels: [], status: "invalid-label" },
      { models: ["https://private.example/path"], labels: [], status: "invalid-label" },
      { models: ["private.example.com"], labels: [], status: "invalid-label" },
      { models: ["sk-unrelated-secret"], labels: [], status: "invalid-label" },
      { models: ["127.0.0.1"], labels: [], status: "invalid-label" },
      { models: ["fixture-model", "sk-unrelated-secret"], labels: [], status: "invalid-label" },
      { models: ["a", "b", "c", "d", "e"], labels: [], status: "invalid-label" },
      { models: ["deepseek-v4.1-flash"], labels: ["deepseek-v4.1-flash"], status: "reported-label" },
    ]
    for (const [index, scenario] of scenarios.entries()) {
      let calls = 0
      const provider = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch() {
          calls++
          const frames = scenario.models.map((model, position) =>
            protocol === "openai-chat"
              ? event({
                  model,
                  choices: position === 0 ? [{ index: 0, delta: { content: "READY" }, finish_reason: "stop" }] : [],
                })
              : event(
                  position === scenario.models.length - 1
                    ? { ...completed, response: { ...completed.response, model } }
                    : { type: "response.created", response: { model } },
                ),
          )
          return new Response(frames.join("") + (protocol === "openai-chat" ? "data: [DONE]\r\n\r\n" : ""), {
            headers: { "content-type": "text/event-stream" },
          })
        },
      })
      try {
        const result = await probeEvaluationText({
          baseURL: `http://127.0.0.1:${provider.port}/v1`,
          apiKey: "private-test-key",
          model: "fixture-model",
          protocol,
          journal: path.join(tmp.path, `${index}.jsonl`),
        })
        expect(result.pass).toBe(true)
        expect(result.responseModels).toEqual(scenario.labels)
        expect(result.responseModelStatus).toBe(scenario.status)
        expect(result.usage.reserve).toBe("retain")
        expect(calls).toBe(1)
        expect(JSON.stringify(result)).not.toContain("private-test-key")
      } finally {
        await provider.stop(true)
      }
    }
  })

test("HTTP errors, redirect, incomplete streams and provider failures never retry or release reservations", async () => {
  await using tmp = await tmpdir()
  const scenarios = [
    { protocol: "openai-chat" as const, status: 401, body: "private-error", reason: "http-failed" },
    { protocol: "openai-chat" as const, status: 307, body: "", reason: "http-failed" },
    {
      protocol: "openai-chat" as const,
      status: 200,
      body: chat.replace("data: [DONE]\r\n\r\n", ""),
      reason: "incomplete-or-invalid-stream",
    },
    {
      protocol: "openai-chat" as const,
      status: 200,
      body: chat.replace('"stop"', '"length"'),
      reason: "incomplete-or-invalid-stream",
    },
    {
      protocol: "openai-chat" as const,
      status: 200,
      body: chat + event({ error: "private-error" }),
      reason: "transport-or-invalid-stream",
    },
    {
      protocol: "openai-responses" as const,
      status: 200,
      body: event({ type: "response.failed", response: { error: "private-error" } }),
      reason: "incomplete-or-invalid-stream",
    },
    {
      protocol: "openai-responses" as const,
      status: 200,
      body: event(completed) + event(completed),
      reason: "incomplete-or-invalid-stream",
    },
  ]
  for (const [index, scenario] of scenarios.entries()) {
    let calls = 0
    const provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        calls++
        return new Response(scenario.body, {
          status: scenario.status,
          headers: { "content-type": "text/event-stream", location: new URL("/redirected", request.url).href },
        })
      },
    })
    try {
      const result = await probeEvaluationText({
        baseURL: `http://127.0.0.1:${provider.port}/v1`,
        apiKey: "private-key",
        model: "fixture-model",
        protocol: scenario.protocol,
        journal: path.join(tmp.path, `${index}.jsonl`),
      })
      expect(result.pass).toBe(false)
      expect(result.reason).toBe(scenario.reason)
      expect(result.usage.reserve).toBe("retain")
      expect(calls).toBe(1)
      expect(JSON.stringify(result)).not.toContain("private-")
    } finally {
      await provider.stop(true)
    }
  }
})

test("host deadline stops a stalled response and remains a single unknown-cost attempt", async () => {
  await using tmp = await tmpdir()
  const waiting = Promise.withResolvers<Response>()
  let calls = 0
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      calls++
      return waiting.promise
    },
  })
  try {
    const result = await probeEvaluationText({
      baseURL: `http://127.0.0.1:${provider.port}/v1`,
      apiKey: "private-key",
      model: "fixture-model",
      protocol: "openai-chat",
      journal: path.join(tmp.path, "deadline.jsonl"),
      deadlineMs: 150,
    })
    expect(result.reason).toBe("deadline")
    expect(result.pass).toBe(false)
    expect(result.usage.observations).toEqual([])
    expect(result.usage.reserve).toBe("retain")
    expect(result.elapsedMs).toBeLessThan(3000)
    expect(calls).toBe(1)
  } finally {
    waiting.resolve(new Response(null, { status: 204 }))
    await provider.stop(true)
  }
}, 5000)
