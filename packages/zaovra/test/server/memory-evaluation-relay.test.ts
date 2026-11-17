import { expect, test } from "bun:test"
import path from "node:path"
import { evaluationRelayBinding, startEvaluationRelay } from "../../../../script/evaluation/memory/relay"
import { tmpdir } from "../fixture/fixture"

test("evaluation relay distinguishes local transport failure from an upstream HTTP 502 without private error text", async () => {
  await using tmp = await tmpdir()
  for (const mode of ["refused", "upstream"] as const) {
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return new Response("private-upstream-error-body", { status: 502 })
      },
    })
    const baseURL = `http://127.0.0.1:${upstream.port}/v1`
    if (mode === "refused") await upstream.stop(true)
    const journal = path.join(tmp.path, mode + ".jsonl")
    const relay = startEvaluationRelay({
      baseURL,
      apiKey: "private-transport-test-key",
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
          messages: [{ role: "user", content: "local fixture" }],
        }),
        signal: AbortSignal.timeout(5000),
      })
      expect(response.status).toBe(502)
      expect(await response.text()).toBe(mode === "refused" ? "" : "private-upstream-error-body")
    } finally {
      await relay.stop()
      await upstream.stop(true)
    }
    const text = await Bun.file(journal).text()
    expect(text).not.toContain("private-transport-test-key")
    expect(text).not.toContain("private-upstream-error-body")
    expect(text).not.toContain(baseURL)
    expect(text).not.toContain(relay.apiKey)
    const rows = text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    const failed = rows.filter((row) => row.phase === "transport-failed")
    if (mode === "upstream") {
      expect(failed).toHaveLength(0)
      expect(rows.filter((row) => row.phase === "headers").map((row) => row.status)).toEqual([502])
      continue
    }
    expect(rows.filter((row) => row.phase === "headers")).toHaveLength(0)
    expect(failed).toHaveLength(1)
    expect(failed[0]).toMatchObject({
      usage: "unknown",
      generatedStatus: 502,
      cancellation: { request: false, relay: false, deadline: false },
    })
    expect(["ECONNREFUSED", "ConnectionRefused"]).toContain(failed[0].error.code)
    expect(failed[0].elapsedMs).toBeGreaterThanOrEqual(0)
    expect(failed[0].elapsedMs).toBeLessThan(5000)
    expect(Object.keys(failed[0].error).sort()).toEqual(["causeCode", "code", "name"])
  }
}, 15000)

test("evaluation relay preserves forty-send plans and caps extended recovery plans at sixty physical sends", async () => {
  await using tmp = await tmpdir()
  for (const limit of [40, 60]) {
    const received: string[] = []
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        received.push(await request.text())
        return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
      },
    })
    try {
      const options = {
        baseURL: `http://127.0.0.1:${upstream.port}/v1`,
        apiKey: "local-fixture-only",
        model: "fixture",
        protocol: "openai-chat" as const,
        journal: path.join(tmp.path, `limit-${limit}.jsonl`),
        maxRequests: limit,
        maxRequestBytes: 4096,
        maxOutput: 64,
      }
      expect(() => startEvaluationRelay({ ...options, maxRequests: 61 })).toThrow("invalid-evaluation-relay")
      expect(await Bun.file(options.journal).exists()).toBe(false)
      const relay = startEvaluationRelay(options)
      const body = JSON.stringify({
        model: "fixture",
        stream: true,
        max_tokens: 64,
        messages: [{ role: "user", content: "bounded local recovery fixture" }],
      })
      const send = async () => {
        const response = await fetch(relay.baseURL + "/chat/completions", {
          method: "POST",
          headers: { authorization: `Bearer ${relay.apiKey}` },
          body,
          signal: AbortSignal.timeout(5000),
        })
        await response.text()
        return response.status
      }
      try {
        const statuses = await Promise.all(Array.from({ length: limit + 2 }, send))
        expect(statuses.filter((status) => status === 200)).toHaveLength(limit)
        expect(statuses.filter((status) => status === 429)).toHaveLength(2)
        expect(await send()).toBe(429)
        expect(received).toEqual(Array.from({ length: limit }, () => body))
      } finally {
        await relay.stop()
      }
      const records = (await Bun.file(options.journal).text())
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
      expect(records.filter((row) => row.phase === "admitted").map((row) => row.ordinal)).toEqual(
        Array.from({ length: limit }, (_, index) => index + 1),
      )
      expect(records.filter((row) => row.phase === "denied" && row.reason === "physical-request-limit")).toHaveLength(3)
    } finally {
      await upstream.stop(true)
    }
  }
}, 15000)

test("evaluation relay closes upstream work on cancel and repeated stop without claiming EOF", async () => {
  await using tmp = await tmpdir()
  for (const mode of ["headers", "cancel", "unread"] as const) {
    const started = Promise.withResolvers<void>()
    const ended = Promise.withResolvers<void>()
    const headers = Promise.withResolvers<Response>()
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        request.signal.addEventListener(
          "abort",
          () => {
            ended.resolve()
            headers.resolve(new Response(null, { status: 204 }))
          },
          { once: true },
        )
        started.resolve()
        if (mode === "headers") return headers.promise
        return new Response(
          new ReadableStream<Uint8Array>({
            start(stream) {
              stream.enqueue(new TextEncoder().encode("data: partial\n\n"))
            },
            cancel() {
              ended.resolve()
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    const journal = path.join(tmp.path, mode + ".jsonl")
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
    const response = fetch(relay.baseURL + "/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${relay.apiKey}` },
      body: JSON.stringify({
        model: "fixture",
        stream: true,
        max_tokens: 64,
        messages: [{ role: "user", content: "hello" }],
      }),
      signal: AbortSignal.timeout(5000),
    }).catch(() => undefined)
    try {
      await Promise.race([
        started.promise,
        Bun.sleep(2000).then(() => {
          throw new Error("fixture-not-started")
        }),
      ])
      if (mode !== "headers") {
        const reply = await response
        expect(reply?.status).toBe(200)
        if (mode === "cancel") {
          const reader = reply!.body!.getReader()
          await reader.read()
          await reader.cancel()
        }
      }
      if (mode !== "cancel") {
        const stopping = relay.stop()
        expect(relay.stop()).toBe(stopping)
        await stopping
      }
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
    expect(records.filter((record) => record.phase === "admitted")).toHaveLength(1)
    expect(records.some((record) => record.phase === "eof")).toBe(false)
  }
}, 20000)

test("evaluation relay validates both wire protocols and bounds concurrent physical sends", async () => {
  await using tmp = await tmpdir()
  for (const protocol of ["openai-chat", "openai-responses"] as const) {
    const received: Array<{ authorization: string | null; body: string; path: string }> = []
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        received.push({
          authorization: request.headers.get("authorization"),
          body: await request.text(),
          path: new URL(request.url).pathname,
        })
        return new Response("data: [DONE]\n\n", {
          headers: { "content-type": "text/event-stream", "x-private": "secret-header" },
        })
      },
    })
    const journal = path.join(tmp.path, protocol + ".jsonl")
    const relay = startEvaluationRelay({
      baseURL: `http://127.0.0.1:${upstream.port}/v1`,
      apiKey: "private-test-credential",
      model: "fixture",
      protocol,
      journal,
      maxRequests: 1,
      maxRequestBytes: 4096,
      maxOutput: 64,
    })
    const suffix = protocol === "openai-chat" ? "/chat/completions" : "/responses"
    const body = {
      model: "fixture",
      stream: true,
      ...(protocol === "openai-chat"
        ? { messages: [{ role: "user", content: "private-test-prompt" }], max_tokens: 64 }
        : {
            input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "private-test-prompt" }] }],
            max_output_tokens: 64,
          }),
    }
    const send = (value: object, tail = "", authorization: string = relay.apiKey) =>
      fetch(relay.baseURL + suffix + tail, {
        method: "POST",
        headers: { authorization: `Bearer ${authorization}` },
        body: JSON.stringify(value),
      })
    try {
      expect((await send(body, "", "wrong")).status).toBe(403)
      expect((await send(body, "?forward=elsewhere")).status).toBe(403)
      expect((await send({ ...body, model: "other" })).status).toBe(400)
      expect((await send({ ...body, stream: false })).status).toBe(400)
      expect((await send({ ...body, unknown_provider_work: true })).status).toBe(400)
      expect(
        (await send({ ...body, [protocol === "openai-chat" ? "max_tokens" : "max_output_tokens"]: 65 })).status,
      ).toBe(400)
      expect(received).toHaveLength(0)
      expect(
        (
          await fetch(relay.baseURL + suffix, {
            method: "POST",
            headers: { authorization: `Bearer ${relay.apiKey}` },
            body: new Uint8Array([0xff]),
          })
        ).status,
      ).toBe(400)
      expect(received).toHaveLength(0)
      const replies = await Promise.all([send(body), send(body)])
      expect(replies.map((reply) => reply.status).sort()).toEqual([200, 429])
      expect(await replies.find((reply) => reply.status === 200)!.text()).toBe("data: [DONE]\n\n")
      expect(replies.find((reply) => reply.status === 200)!.headers.get("x-private")).toBeNull()
      expect(received).toEqual([
        { authorization: "Bearer private-test-credential", body: JSON.stringify(body), path: "/v1" + suffix },
      ])
      expect((await send(body)).status).toBe(429)
    } finally {
      await relay.stop()
      await upstream.stop(true)
    }
    const text = await Bun.file(journal).text()
    expect(text).not.toContain("private-test-credential")
    expect(text).not.toContain("private-test-prompt")
    expect(text).not.toContain(relay.apiKey)
    const records = text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(records.filter((record) => record.phase === "admitted")).toHaveLength(1)
    expect(records.find((record) => record.phase === "eof")).toMatchObject({ phase: "eof", usage: "unknown" })
    expect(() =>
      startEvaluationRelay({
        baseURL: "https://example.invalid/v1",
        apiKey: "unused",
        model: "fixture",
        protocol,
        journal,
        maxRequests: 1,
        maxRequestBytes: 4096,
        maxOutput: 64,
      }),
    ).toThrow()
  }
})

test("evaluation relay refuses redirects, media references and oversized requests without forwarding twice", async () => {
  await using tmp = await tmpdir()
  let redirects = 0
  const target = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      redirects++
      return new Response("must not run")
    },
  })
  let sends = 0
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      sends++
      return Response.redirect(`http://127.0.0.1:${target.port}/`, 307)
    },
  })
  const relay = startEvaluationRelay({
    baseURL: `http://127.0.0.1:${upstream.port}/v1`,
    apiKey: "private-test-key",
    model: "fixture",
    protocol: "openai-chat",
    journal: path.join(tmp.path, "redirect.jsonl"),
    maxRequests: 1,
    maxRequestBytes: 4096,
    maxOutput: 64,
  })
  const body = { model: "fixture", stream: true, max_tokens: 64, messages: [{ role: "user", content: "hello" }] }
  const send = (value: object) =>
    fetch(relay.baseURL + "/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${relay.apiKey}` },
      body: JSON.stringify(value),
    })
  try {
    expect(
      (
        await send({
          ...body,
          messages: [
            { role: "user", content: [{ type: "image_url", image_url: { url: "https://example.invalid/large" } }] },
          ],
        })
      ).status,
    ).toBe(400)
    expect((await send({ ...body, messages: [{ role: "user", content: "x".repeat(5000) }] })).status).toBe(413)
    expect(sends).toBe(0)
    expect((await send(body)).status).toBe(502)
    expect(sends).toBe(1)
    expect(redirects).toBe(0)
    expect((await send(body)).status).toBe(429)
  } finally {
    await relay.stop()
    await upstream.stop(true)
    await target.stop(true)
  }
})

test("owned relay identity is frozen and a copied or stopped handle cannot grant C permission", async () => {
  await using tmp = await tmpdir()
  const options = {
    baseURL: "http://127.0.0.1:9/v1",
    apiKey: "fixture-only",
    model: "fixed",
    protocol: "openai-chat" as const,
    journal: path.join(tmp.path, "owned.jsonl"),
    maxRequests: 1,
    maxRequestBytes: 4096,
    maxOutput: 64,
  }
  const relay = startEvaluationRelay(options)
  try {
    const before = evaluationRelayBinding(relay)
    options.model = "changed"
    options.baseURL = "http://127.0.0.1:8/v1"
    options.maxRequests = 40
    relay.baseURL = "http://127.0.0.1:8/v1"
    expect(evaluationRelayBinding(relay)).toEqual(before)
    relay.baseURL = before.baseURL
    expect(() => evaluationRelayBinding({ ...relay })).toThrow("evaluation-relay-not-owned")
    const response = await fetch(relay.baseURL + "/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${relay.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "changed",
        messages: [{ role: "user", content: "local fixture" }],
        stream: true,
        max_tokens: 64,
      }),
    })
    expect(response.status).toBe(400)
    await relay.stop()
    expect(() => evaluationRelayBinding(relay)).toThrow("evaluation-relay-closed")
  } finally {
    await relay.stop()
  }
})

for (const delay of ["headers", "frames"] as const)
  test(`evaluation relay preserves a stream with ${delay} idle longer than ten seconds`, async () => {
    await using tmp = await tmpdir()
    const first = "data: first\n\n"
    const last = "data: last\n\ndata: [DONE]\n\n"
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      // Only the relay under test should exercise Bun's default idle timeout.
      idleTimeout: 0,
      async fetch() {
        if (delay === "headers") {
          await Bun.sleep(11500)
          return new Response(first + last, { headers: { "content-type": "text/event-stream" } })
        }
        let timer: ReturnType<typeof setTimeout>
        return new Response(
          new ReadableStream<Uint8Array>({
            start(stream) {
              stream.enqueue(new TextEncoder().encode(first))
              timer = setTimeout(() => {
                stream.enqueue(new TextEncoder().encode(last))
                stream.close()
              }, 11500)
            },
            cancel() {
              clearTimeout(timer)
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    const journal = path.join(tmp.path, "delayed.jsonl")
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
        signal: AbortSignal.timeout(20000),
      })
      expect(response.status).toBe(200)
      expect(await response.text()).toBe(first + last)
    } finally {
      await relay.stop()
      await upstream.stop(true)
    }
    const records = (await Bun.file(journal).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(records.filter((record) => record.phase === "admitted")).toHaveLength(1)
    expect(records.filter((record) => record.phase === "eof")).toHaveLength(1)
    expect(records.some((record) => record.phase === "incomplete" || record.phase === "transport-failed")).toBe(false)
  }, 25000)
