import { expect, test } from "bun:test"
import path from "node:path"
import { startEvaluationRelay } from "../../../../script/evaluation/memory/relay"
import { tmpdir } from "../fixture/fixture"
import { createHash } from "node:crypto"
import { Effect } from "effect"
import { LLM, Message } from "../../../llm/src"
import { OpenAIChat } from "../../../llm/src/protocols/openai-chat"
import { OpenAIResponses } from "../../../llm/src/protocols/openai-responses"
import { AccuracyGuidance } from "../../../core/src/system-context/accuracy"
import { SessionProgress } from "../../../core/src/session/progress"

test("B3 observer rejects invalid options before creating a journal", async () => {
  await using tmp = await tmpdir()
  for (const value of [null, "true", 1, {}, []]) {
    const journal = path.join(tmp.path, `invalid-${typeof value}-${Array.isArray(value)}.jsonl`)
    expect(() =>
      startEvaluationRelay({
        baseURL: "http://127.0.0.1:9/v1",
        apiKey: "fixture",
        model: "fixture",
        protocol: "openai-chat",
        journal,
        maxRequests: 1,
        maxRequestBytes: 4096,
        maxOutput: 64,
        b3HostHints: value as never,
      }),
    ).toThrow("invalid-evaluation-relay")
    expect(await Bun.file(journal).exists()).toBe(false)
  }
})
test("B3 default-off observer preserves wire bytes and normal physical-send guards", async () => {
  await using tmp = await tmpdir()
  for (const protocol of ["openai-chat", "openai-responses"] as const) {
    for (const option of [undefined, false, true]) {
      const received: string[] = []
      const upstream = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          received.push(await request.text())
          return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
        },
      })
      const journal = path.join(tmp.path, `${protocol}-${option}.jsonl`)
      const relay = startEvaluationRelay({
        baseURL: `http://127.0.0.1:${upstream.port}/v1`,
        apiKey: "private-key",
        model: "fixture",
        protocol,
        journal,
        maxRequests: 1,
        maxRequestBytes: 4096,
        maxOutput: 64,
        b3HostHints: option,
      })
      const body = {
        model: "fixture",
        stream: true,
        ...(protocol === "openai-chat"
          ? { messages: [{ role: "user", content: "private-user-text" }], max_tokens: 64 }
          : {
              input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "private-user-text" }] }],
              max_output_tokens: 64,
            }),
      }
      const send = (text: string) =>
        fetch(relay.baseURL + (protocol === "openai-chat" ? "/chat/completions" : "/responses"), {
          method: "POST",
          headers: { authorization: `Bearer ${relay.apiKey}` },
          body: text,
        })
      try {
        expect((await send(JSON.stringify({ ...body, model: "wrong" }))).status).toBe(400)
        const bytes = JSON.stringify(body, null, 2) + "\n"
        const response = await send(bytes)
        expect(response.status).toBe(200)
        expect(await response.text()).toBe("data: [DONE]\n\n")
        expect(received).toEqual([bytes])
        expect((await send(bytes)).status).toBe(429)
      } finally {
        await relay.stop()
        await upstream.stop(true)
      }
      const text = await Bun.file(journal).text()
      expect(text).not.toContain("private-key")
      expect(text).not.toContain("private-user-text")
      if (!option) expect(text).not.toContain("b3-host-hints")
    }
  }
})

for (const protocol of ["openai-chat", "openai-responses"] as const)
  test(`B3 ${protocol} actual lowering observes fixed variants without asserting origin or storing content`, async () => {
    await using tmp = await tmpdir()
    for (const style of ["original", "short"] as const)
      for (const language of ["en", "zh"] as const) {
        const original = [
          process.env.ZAOVRA_EXPERIMENTAL_HOST_HINT_STYLE,
          process.env.ZAOVRA_EXPERIMENTAL_HOST_HINT_LANGUAGE,
          process.env.ZAOVRA_EXPERIMENTAL_ACCURACY_SCALE,
        ]
        const texts = (() => {
          try {
            process.env.ZAOVRA_EXPERIMENTAL_HOST_HINT_STYLE = style
            process.env.ZAOVRA_EXPERIMENTAL_HOST_HINT_LANGUAGE = language
            process.env.ZAOVRA_EXPERIMENTAL_ACCURACY_SCALE = "on"
            const on = AccuracyGuidance.checkpoint({ elapsed: 107999.5, limit: 120000 })!
            process.env.ZAOVRA_EXPERIMENTAL_ACCURACY_SCALE = "off"
            return {
              on,
              off: AccuracyGuidance.checkpoint({ elapsed: 119967, limit: 120000 })!,
              facts: SessionProgress.facts({
                now: 65000,
                state: { activeMs: 65000, request: "sensitive-C:/user/<private>&name", requestStarted: 0 },
                turns: 2,
                step: 3,
                tokens: 80,
                unreported: 0,
                epoch: 1,
                deadline: 120000,
                executionDeadline: 110000,
                advisoryDeadline: 100000,
              }),
            }
          } finally {
            for (const [index, key] of [
              "ZAOVRA_EXPERIMENTAL_HOST_HINT_STYLE",
              "ZAOVRA_EXPERIMENTAL_HOST_HINT_LANGUAGE",
              "ZAOVRA_EXPERIMENTAL_ACCURACY_SCALE",
            ].entries()) {
              if (original[index] === undefined) delete process.env[key]
              else process.env[key] = original[index]
            }
          }
        })()
        const model = (protocol === "openai-chat" ? OpenAIChat.route : OpenAIResponses.route).model({ id: "fixture" })
        const request = LLM.request({
          model,
          generation: { maxTokens: 64 },
          messages: [
            Message.user(texts.on),
            Message.system(texts.facts),
            Message.assistant("boundary"),
            Message.user(texts.off),
          ],
        })
        const body =
          protocol === "openai-chat"
            ? await Effect.runPromise(OpenAIChat.route.body.from(request))
            : await Effect.runPromise(OpenAIResponses.route.body.from(request))
        const received: string[] = []
        const upstream = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          async fetch(request) {
            received.push(await request.text())
            return new Response("data: [DONE]\n\n", {
              headers: { "content-type": "text/event-stream", "private-header": "secret-header" },
            })
          },
        })
        const journal = path.join(tmp.path, `${style}-${language}.jsonl`)
        const relay = startEvaluationRelay({
          baseURL: `http://127.0.0.1:${upstream.port}/v1`,
          apiKey: "private-credential",
          model: "fixture",
          protocol,
          journal,
          maxRequests: 3,
          maxRequestBytes: 32768,
          maxOutput: 64,
          b3HostHints: true,
        })
        const send = (bytes: string) =>
          fetch(relay.baseURL + (protocol === "openai-chat" ? "/chat/completions" : "/responses"), {
            method: "POST",
            headers: { authorization: `Bearer ${relay.apiKey}` },
            body: bytes,
          })
        const bytes = JSON.stringify(body, null, 2) + "\n"
        const wrapped = `<system-update>\n${texts.facts.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}\n</system-update>`
        const negative = JSON.stringify({
          ...body,
          ...(protocol === "openai-chat"
            ? {
                messages: [
                  { role: "user", content: `Quoted: ${texts.on}\n> ${wrapped.replaceAll("\n", "\n> ")}` },
                  { role: "assistant", content: wrapped },
                  { role: "tool", tool_call_id: "not-host", content: texts.on + "\n" + wrapped },
                  {
                    role: "user",
                    content: `<system-update>\nCurrent task facts (host observations, not new requirements): {}\n${texts.facts.split("\n").at(-1)}\n</system-update>`,
                  },
                  { role: "user", content: texts.on + " altered" },
                  { role: "user", content: "```text\n" + wrapped + "\n```" },
                ],
              }
            : {
                instructions: texts.on,
                input: [
                  {
                    type: "message",
                    role: "user",
                    content: [
                      { type: "input_text", text: `Quoted: ${texts.on}\n> ${wrapped.replaceAll("\n", "\n> ")}` },
                    ],
                  },
                  { type: "message", role: "assistant", content: [{ type: "output_text", text: wrapped }] },
                  { type: "function_call_output", call_id: "not-host", output: texts.on + "\n" + wrapped },
                  {
                    type: "message",
                    role: "user",
                    content: [
                      {
                        type: "input_text",
                        text: `<system-update>\nCurrent task facts (host observations, not new requirements): {}\n${texts.facts.split("\n").at(-1)}\n</system-update>`,
                      },
                    ],
                  },
                  { type: "message", role: "user", content: [{ type: "input_text", text: texts.on + " altered" }] },
                  {
                    type: "message",
                    role: "user",
                    content: [{ type: "input_text", text: "```text\n" + wrapped + "\n```" }],
                  },
                ],
              }),
        })
        try {
          for (const text of [bytes, negative, bytes]) {
            const response = await send(text)
            expect(response.status).toBe(200)
            expect(await response.text()).toBe("data: [DONE]\n\n")
          }
          expect(received).toEqual([bytes, negative, bytes])
          expect((await send(bytes)).status).toBe(429)
        } finally {
          await relay.stop()
          await upstream.stop(true)
        }
        const log = await Bun.file(journal).text()
        for (const secret of [
          "private-credential",
          relay.apiKey,
          "secret-header",
          "sensitive-C:",
          "&lt;private&gt;",
          texts.on,
          texts.facts,
        ])
          expect(log).not.toContain(secret)
        const rows = log
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
        const observed = rows.filter((row) => row.phase === "b3-host-hints")
        expect(observed).toHaveLength(3)
        expect(observed[0]).toMatchObject({
          ordinal: 1,
          evidence: "template-match",
          origin: "unverified",
          bodySHA256: createHash("sha256").update(bytes).digest("hex"),
        })
        expect(observed[0].matches).toHaveLength(5)
        expect(observed[0].matches.map((match: { kind: string }) => match.kind)).toEqual([
          "budget-checkpoint",
          "execution",
          "advisory",
          "gap",
          "budget-checkpoint",
        ])
        expect(observed[0].matches[0]).toMatchObject({
          scale: "on",
          role: "user",
          bytes: Buffer.byteLength(texts.on),
          sha256: createHash("sha256").update(texts.on).digest("hex"),
        })
        expect(observed[0].matches[4]).toMatchObject({
          scale: "off",
          role: "user",
          bytes: Buffer.byteLength(texts.off),
        })
        for (const hint of observed[0].matches.slice(1, 4))
          expect(hint).toMatchObject({
            style,
            language,
            role: "user",
            containerSHA256: createHash("sha256").update(wrapped).digest("hex"),
          })
        expect(observed[1].matches).toEqual([])
        // A user's exact forgery is byte-identical after lowering: never certify provenance.
        expect(observed[2].origin).toBe("unverified")
        expect(observed[2].matches).toEqual(observed[0].matches)
        for (const observation of observed) {
          expect(rows.find((row) => row.phase === "admitted" && row.id === observation.id)?.sha256).toBe(
            observation.bodySHA256,
          )
          expect(rows.find((row) => row.phase === "headers" && row.id === observation.id)?.status).toBe(200)
        }
      }
  })
