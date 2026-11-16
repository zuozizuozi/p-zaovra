import { expect, test } from "bun:test"
import path from "node:path"
import { observeUsage } from "../../../../script/evaluation/memory/usage"
import { startEvaluationRelay } from "../../../../script/evaluation/memory/relay"
import { tmpdir } from "../fixture/fixture"

for (const protocol of ["openai-chat", "openai-responses"] as const) {
  const frame = (model: unknown, terminal: boolean) =>
    `data: ${JSON.stringify(
      protocol === "openai-chat"
        ? {
            ...(model === undefined ? {} : { model }),
            choices: [{ delta: { content: "private-response-text" }, finish_reason: terminal ? "stop" : null }],
            ...(terminal ? { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } } : {}),
          }
        : {
            type: terminal ? "response.completed" : "response.created",
            response: {
              ...(model === undefined ? {} : { model }),
              ...(terminal ? { usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } : {}),
              output: [{ text: "private-response-text" }],
            },
          },
    )}\r\n\r\n`

  for (const scenario of [
    "missing",
    "early",
    "terminal",
    "repeat",
    "conflict",
    "invalid-type",
    "empty",
    "long",
    "max-length",
    "url",
    "domain-url",
    "secret",
    "local-secret",
    "four",
    "overflow",
    "truncated",
    "trailing",
    "malformed",
  ] as const)
    test(`real relay response labels preserve bytes and admission: ${protocol}/${scenario}`, async () => {
      await using tmp = await tmpdir()
      let sent = 0
      let payload = ""
      const upstream = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => {
          sent++
          const bytes = new TextEncoder().encode(payload)
          let offset = 0
          return new Response(
            new ReadableStream<Uint8Array>({
              async pull(controller) {
                if (offset === bytes.length) {
                  controller.close()
                  return
                }
                controller.enqueue(bytes.slice(offset, offset + 7))
                offset = Math.min(bytes.length, offset + 7)
                await Bun.sleep(1)
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          )
        },
      })
      const journal = path.join(tmp.path, "relay.jsonl")
      const relay = startEvaluationRelay({
        baseURL: `http://127.0.0.1:${upstream.port}/v1`,
        apiKey: "private-key-123",
        model: "fixture",
        protocol,
        journal,
        maxRequests: 1,
        maxRequestBytes: 4096,
        maxOutput: 64,
      })
      const invalid = [
        "invalid-type",
        "empty",
        "long",
        "url",
        "domain-url",
        "secret",
        "local-secret",
        "overflow",
        "malformed",
      ].includes(scenario)
      const label =
        scenario === "invalid-type"
          ? { private: "hidden-label" }
          : scenario === "empty"
            ? ""
            : scenario === "long"
              ? "x".repeat(161)
              : scenario === "max-length"
                ? "x".repeat(160)
                : scenario === "url"
                  ? "https://private.example/path"
                  : scenario === "domain-url"
                    ? "private.example.com"
                    : scenario === "secret"
                      ? "prefix-private-key-123-suffix"
                      : scenario === "local-secret"
                        ? relay.apiKey
                        : "model-a"
      payload =
        frame(scenario === "missing" || scenario === "terminal" ? undefined : label, false) +
        (scenario === "repeat" ? frame("model-a", false) : "") +
        (scenario === "overflow"
          ? ["model-b", "model-c", "model-d", "model-e"].map((value) => frame(value, false)).join("")
          : "") +
        (scenario === "four" ? ["model-b", "model-c", "model-d"].map((value) => frame(value, false)).join("") : "") +
        (scenario === "malformed" ? "data: invalid-json\r\n\r\n" : "") +
        frame(
          scenario === "conflict"
            ? "model-b"
            : scenario === "terminal" || scenario === "repeat"
              ? "model-a"
              : undefined,
          true,
        )
      if (scenario === "truncated") payload = payload.slice(0, -4)
      if (scenario === "trailing") payload += 'data: {"model":"unfinished'
      const request = {
        method: "POST",
        headers: { authorization: `Bearer ${relay.apiKey}` },
        body: JSON.stringify({
          model: "fixture",
          stream: true,
          ...(protocol === "openai-chat"
            ? { max_tokens: 64, messages: [{ role: "user", content: "private-prompt" }] }
            : {
                max_output_tokens: 64,
                input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "private-prompt" }] }],
              }),
        }),
      }
      const url = relay.baseURL + (protocol === "openai-chat" ? "/chat/completions" : "/responses")
      try {
        const response = await fetch(url, request)
        expect(response.status).toBe(200)
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(new TextEncoder().encode(payload))
        expect((await fetch(url, request)).status).toBe(429)
        expect(sent).toBe(1)
      } finally {
        await relay.stop()
        await upstream.stop(true)
      }
      const text = await Bun.file(journal).text()
      const records = text
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
      const admitted = records.filter((row) => row.phase === "admitted")
      expect(admitted).toHaveLength(1)
      const models = records.filter((row) => row.phase === "response-model-observed")
      expect(models).toEqual([
        {
          id: admitted[0].id,
          phase: "response-model-observed",
          end: "eof",
          status: ["truncated", "trailing"].includes(scenario) ? "incomplete" : "complete",
          labelStatus: invalid
            ? "invalid"
            : scenario === "missing"
              ? "unreported"
              : ["conflict", "four"].includes(scenario)
                ? "conflicting"
                : "consistent",
          labels:
            invalid || scenario === "missing"
              ? []
              : scenario === "conflict"
                ? ["model-a", "model-b"]
                : scenario === "four"
                  ? ["model-a", "model-b", "model-c", "model-d"]
                  : scenario === "max-length"
                    ? ["x".repeat(160)]
                    : ["model-a"],
          basis: "provider-response-label-only",
        },
      ])
      const usage = records.filter((row) => row.phase === "usage-observed")
      expect(usage).toEqual([
        {
          id: admitted[0].id,
          phase: "usage-observed",
          end: "eof",
          ...(scenario === "truncated"
            ? { status: "unknown", reason: "no-terminal-usage" }
            : scenario === "malformed"
              ? { status: "unknown", reason: "invalid-frame" }
              : { status: "reported", input: 10, output: 5, total: 15, basis: "provider-terminal-usage" }),
        },
      ])
      for (const privateValue of [
        "private-key-123",
        relay.apiKey,
        "private-prompt",
        "private-response-text",
        "private.example",
        "hidden-label",
        "x".repeat(161),
      ])
        expect(text).not.toContain(privateValue)
      // Exact same payload, one byte per feed, independent of HTTP chunk coalescing.
      const observer = observeUsage(protocol, ["private-key-123", relay.apiKey])
      for (const byte of new TextEncoder().encode(payload)) observer.feed(Uint8Array.of(byte))
      expect(observer.models("eof")).toEqual({
        status: models[0].status,
        labelStatus: models[0].labelStatus,
        labels: models[0].labels,
        basis: models[0].basis,
      })
      console.log(
        JSON.stringify({
          protocol,
          scenario,
          physicalSends: sent,
          bytes: new TextEncoder().encode(payload).length,
          modelRecord: models[0],
          usageRecord: usage[0],
          transparent: true,
        }),
      )
    })
  for (const mode of ["client", "relay", "headers"] as const)
    test(`real relay records unfinished labels once on cancellation: ${protocol}/${mode}`, async () => {
      await using tmp = await tmpdir()
      const started = Promise.withResolvers<void>()
      const ended = Promise.withResolvers<void>()
      const headers = Promise.withResolvers<Response>()
      let sent = 0
      const upstream = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          sent++
          request.signal.addEventListener("abort", () => ended.resolve(), { once: true })
          started.resolve()
          if (mode === "headers") return headers.promise
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(frame("model-a", true)))
              },
              cancel() {
                ended.resolve()
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          )
        },
      })
      const journal = path.join(tmp.path, "cancel.jsonl")
      const relay = startEvaluationRelay({
        baseURL: `http://127.0.0.1:${upstream.port}/v1`,
        apiKey: "private-key-123",
        model: "fixture",
        protocol,
        journal,
        maxRequests: 1,
        maxRequestBytes: 4096,
        maxOutput: 64,
      })
      const response = fetch(relay.baseURL + (protocol === "openai-chat" ? "/chat/completions" : "/responses"), {
        method: "POST",
        headers: { authorization: `Bearer ${relay.apiKey}` },
        body: JSON.stringify({
          model: "fixture",
          stream: true,
          ...(protocol === "openai-chat"
            ? { max_tokens: 64, messages: [{ role: "user", content: "hello" }] }
            : {
                max_output_tokens: 64,
                input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
              }),
        }),
        signal: AbortSignal.timeout(5000),
      }).catch(() => undefined)
      try {
        await Promise.race([
          started.promise,
          Bun.sleep(2000).then(() => {
            throw new Error("upstream-not-started")
          }),
        ])
        if (mode !== "headers") {
          const reply = await response
          expect(reply?.status).toBe(200)
          const reader = reply!.body!.getReader()
          expect((await reader.read()).value?.length).toBeGreaterThan(0)
          if (mode === "client") await reader.cancel()
        }
        if (mode !== "client") await relay.stop()
        await Promise.race([
          ended.promise,
          Bun.sleep(2000).then(() => {
            throw new Error("upstream-not-cancelled")
          }),
        ])
      } finally {
        headers.resolve(new Response(null, { status: 204 }))
        await relay.stop()
        await upstream.stop(true)
        await response
      }
      const records = (await Bun.file(journal).text())
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
      const admitted = records.filter((row) => row.phase === "admitted")
      expect(sent).toBe(1)
      expect(admitted).toHaveLength(1)
      const models = records.filter((row) => row.phase === "response-model-observed")
      expect(models).toHaveLength(1)
      expect(models[0]).toMatchObject({
        id: admitted[0].id,
        status: "incomplete",
        labelStatus: mode === "headers" ? "unreported" : "consistent",
        labels: mode === "headers" ? [] : ["model-a"],
      })
      expect(["incomplete", "cancelled"]).toContain(models[0].end)
      console.log(JSON.stringify({ protocol, mode, physicalSends: sent, modelRecord: models[0] }))
    }, 10000)

  test(`label observation never upgrades truncated UTF-8 on repeated reads: ${protocol}`, () => {
    const observer = observeUsage(protocol)
    observer.feed(new TextEncoder().encode(frame("model-a", true)))
    observer.feed(Uint8Array.of(0xe4, 0xb8))
    const first = observer.models("eof")
    expect(first).toMatchObject({ status: "incomplete", labelStatus: "consistent", labels: ["model-a"] })
    expect(observer.models("eof")).toEqual(first)
    expect(observer.result()).toEqual({
      status: "reported",
      input: 10,
      output: 5,
      total: 15,
      basis: "provider-terminal-usage",
    })
  })

  for (const status of [204, 302])
    test(`real relay labels absent bodies and failed transport: ${protocol}/${status}`, async () => {
      await using tmp = await tmpdir()
      let sent = 0
      const upstream = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch() {
          sent++
          return new Response(null, {
            status,
            headers: status === 302 ? { location: "http://127.0.0.1:1/forbidden" } : {},
          })
        },
      })
      const journal = path.join(tmp.path, "empty.jsonl")
      const relay = startEvaluationRelay({
        baseURL: `http://127.0.0.1:${upstream.port}/v1`,
        apiKey: "private-key-123",
        model: "fixture",
        protocol,
        journal,
        maxRequests: 1,
        maxRequestBytes: 4096,
        maxOutput: 64,
      })
      try {
        const response = await fetch(
          relay.baseURL + (protocol === "openai-chat" ? "/chat/completions" : "/responses"),
          {
            method: "POST",
            headers: { authorization: `Bearer ${relay.apiKey}` },
            body: JSON.stringify({
              model: "fixture",
              stream: true,
              ...(protocol === "openai-chat"
                ? { max_tokens: 64, messages: [{ role: "user", content: "hello" }] }
                : {
                    max_output_tokens: 64,
                    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
                  }),
            }),
          },
        )
        expect(response.status).toBe(status === 204 ? 204 : 502)
        expect(await response.text()).toBe("")
      } finally {
        await relay.stop()
        await upstream.stop(true)
      }
      const records = (await Bun.file(journal).text())
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
      const admitted = records.filter((row) => row.phase === "admitted")
      expect(sent).toBe(1)
      expect(admitted).toHaveLength(1)
      expect(records.filter((row) => row.phase === "response-model-observed")).toEqual([
        {
          id: admitted[0].id,
          phase: "response-model-observed",
          end: status === 204 ? "eof" : "incomplete",
          status: "incomplete",
          labelStatus: "unreported",
          labels: [],
          basis: "provider-response-label-only",
        },
      ])
      console.log(
        JSON.stringify({
          protocol,
          httpStatus: status,
          physicalSends: sent,
          modelRecord: records.find((row) => row.phase === "response-model-observed"),
        }),
      )
    })
}
