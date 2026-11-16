import { expect, test } from "bun:test"
import path from "node:path"
import { startEvaluationRelay } from "../../../../script/evaluation/memory/relay"
import { tmpdir } from "../fixture/fixture"

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
