import { expect, test } from "bun:test"
import path from "node:path"
import { observeUsage } from "../../../../script/evaluation/memory/usage"
import { startEvaluationRelay } from "../../../../script/evaluation/memory/relay"
import { tmpdir } from "../fixture/fixture"

const sse = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`
const response = (status = "completed") => ({ type: `response.${status}`, response: { status } })
const chat = (reason: unknown = "stop", index = 0) => ({ choices: [{ index, delta: {}, finish_reason: reason }] })

for (const status of ["completed", "incomplete", "failed"])
  test(`termination observes Responses ${status} without usage or EOF`, () => {
    const observer = observeUsage("openai-responses")
    observer.feed(new TextEncoder().encode(sse(response(status))))
    expect(observer.termination()).toMatchObject({
      status: "observed",
      responses: status,
      count: 1,
      framing: "complete",
    })
    expect(observer.result().status).toBe("unknown")
    expect(observer.models("cancelled").status).toBe("incomplete")
    expect(observer.termination().status).toBe("observed")
  })

for (const [name, bytes] of [
  ["duplicate", sse(response()) + sse(response())],
  ["conflict", sse(response()) + sse(response("failed"))],
  ["status mismatch", sse({ type: "response.completed", response: { status: "failed" } })],
  ["missing status", sse({ type: "response.completed", response: {} })],
  ["malformed", "data: not-json\n\n" + sse(response())],
  ["error before terminal", sse({ type: "error", error: "private" }) + sse(response())],
  ["tail", sse(response()) + "data: {"],
  ["later event", sse(response()) + sse({ type: "response.output_text.delta", delta: "private" })],
] as const)
  test(`termination does not certify ${name}`, () => {
    const observer = observeUsage("openai-responses")
    observer.feed(new TextEncoder().encode(bytes))
    expect(observer.termination().status).not.toBe("observed")
    expect(JSON.stringify(observer.termination())).not.toContain("private")
  })

for (const protocol of ["openai-chat", "openai-responses"] as const)
  test(`terminal observation is invariant across every byte split: ${protocol}`, () => {
    const bytes = new TextEncoder().encode(
      protocol === "openai-responses"
        ? sse({ type: "response.output_text.delta", delta: "中文" }) + sse(response())
        : sse({ choices: [{ index: 0, delta: { content: "中文" }, finish_reason: null }] }) +
            sse(chat()) +
            "data: [DONE]\r\n\r\n",
    )
    for (let offset = 0; offset <= bytes.length; offset++) {
      const observer = observeUsage(protocol)
      observer.feed(bytes.slice(0, offset))
      observer.feed(bytes.slice(offset))
      expect(observer.termination()).toMatchObject({ status: "observed", framing: "complete", consumer: "unproven" })
    }
  })

test("termination detects split/truncated UTF8 independently of numeric usage", () => {
  const observer = observeUsage("openai-responses")
  observer.feed(
    new TextEncoder().encode(
      sse({ ...response(), response: { status: "completed", usage: { input_tokens: 1, output_tokens: 2 } } }),
    ),
  )
  observer.feed(new Uint8Array([0xe4, 0xb8]))
  expect(observer.result()).toMatchObject({ status: "reported", total: 3 })
  expect(observer.termination()).toMatchObject({ status: "ambiguous", framing: "incomplete" })
  expect(observer.termination().status).toBe("ambiguous")
  const invalid = observeUsage("openai-responses")
  invalid.feed(new Uint8Array([0xff]))
  invalid.feed(new TextEncoder().encode(sse(response())))
  expect(invalid.termination().status).toBe("ambiguous")
})

test("Chat finish reasons and DONE are separate bounded facts", () => {
  const observer = observeUsage("openai-chat")
  observer.feed(new TextEncoder().encode(sse(chat("length"))))
  expect(observer.termination()).toMatchObject({
    status: "observed",
    chat: [{ index: 0, reason: "length" }],
    done: false,
  })
  observer.feed(
    new TextEncoder().encode(
      sse({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 2 } }) + "data: [DONE]\n\n",
    ),
  )
  expect(observer.termination()).toMatchObject({ status: "observed", done: true })
  expect(observer.result()).toMatchObject({ status: "reported", total: 3 })
})

for (const [name, bytes] of [
  ["DONE only", "data: [DONE]\n\n"],
  ["duplicate DONE", sse(chat()) + "data: [DONE]\n\ndata: [DONE]\n\n"],
  ["duplicate finish", sse(chat()) + sse(chat())],
  ["unknown reason", sse(chat("secret-unbounded-reason"))],
  ["missing choice finish", sse(chat(null, 1)) + sse(chat()) + "data: [DONE]\n\n"],
  ["too many choices", sse({ choices: Array.from({ length: 17 }, (_, index) => chat("stop", index).choices[0]) })],
] as const)
  test(`Chat ${name} is not a certified terminal observation`, () => {
    const observer = observeUsage("openai-chat")
    observer.feed(new TextEncoder().encode(bytes))
    expect(observer.termination().status).not.toBe("observed")
    expect(JSON.stringify(observer.termination())).not.toContain("secret-unbounded-reason")
  })

for (const terminal of [false, true])
  test(`real HTTP downstream cancellation ${terminal ? "after terminal" : "before terminal"} remains distinguishable`, async () => {
    await using tmp = await tmpdir()
    const payload = terminal ? sse(response()) : sse({ type: "response.created", response: { status: "in_progress" } })
    let sent = 0
    let cancelled = false
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        sent++
        // Keep HTTP open: only the real downstream consumer can cause this cancel.
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(payload))
            },
            cancel() {
              cancelled = true
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    const journal = path.join(tmp.path, "relay.jsonl")
    const relay = startEvaluationRelay({
      baseURL: `http://127.0.0.1:${upstream.port}/v1`,
      apiKey: "fixture",
      model: "fixture",
      protocol: "openai-responses",
      journal,
      maxRequests: 1,
      maxRequestBytes: 4096,
      maxOutput: 64,
    })
    try {
      const result = await fetch(`${relay.baseURL}/responses`, {
        method: "POST",
        headers: { authorization: `Bearer ${relay.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: "fixture",
          input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "local" }] }],
          stream: true,
          max_output_tokens: 64,
        }),
        signal: AbortSignal.timeout(5000),
      })
      expect(result.status).toBe(200)
      const reader = result.body!.getReader()
      let received = ""
      while (!received.endsWith("\n\n")) {
        const chunk = await reader.read()
        if (chunk.done) throw new Error("fixture-ended-before-frame")
        received += new TextDecoder().decode(chunk.value)
      }
      expect(received).toBe(payload)
      await reader.cancel()
      for (let i = 0; i < 100 && !cancelled; i++) await Bun.sleep(10)
      const lines = (await Bun.file(journal).text())
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
      expect(lines.filter((line) => line.phase === "response-termination-observed")).toHaveLength(1)
      expect(lines.find((line) => line.phase === "response-termination-observed")).toMatchObject({
        end: "cancelled",
        status: terminal ? "observed" : "unobserved",
        consumer: "unproven",
      })
      expect(lines.find((line) => line.phase === "response-model-observed")).toMatchObject({
        end: "cancelled",
        status: "incomplete",
      })
      expect(lines.find((line) => line.phase === "usage-observed").status).toBe("unknown")
      expect(sent).toBe(1)
      expect(cancelled).toBe(true)
      if (process.env.ZAOVRA_TEST_REPORT_DIR)
        await Bun.write(
          path.join(process.env.ZAOVRA_TEST_REPORT_DIR, `termination-${terminal}.json`),
          JSON.stringify({ payload, received, lines, sent, cancelled }, null, 2),
        )
    } finally {
      relay.stop()
      await upstream.stop(true)
    }
  }, 10000)
