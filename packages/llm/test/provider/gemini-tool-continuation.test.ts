import { expect } from "bun:test"
import { Effect } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import path from "node:path"
import { LLM, Message, ToolCallPart } from "../../src"
import { Google } from "../../src/providers"
import type { GeminiBody } from "../../src/protocols/gemini"
import { LLMClient } from "../../src/route"
import { testEffect } from "../lib/effect"
import { runtimeLayer } from "../lib/http"
import { sseEvents } from "../lib/sse"

testEffect(runtimeLayer(FetchHttpClient.layer)).live(
  "594 Gemini tool continuation preserves history and does not end in a model turn",
  () =>
    Effect.gen(function* () {
      const requests: GeminiBody[] = []
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          const raw = await request.text()
          const body = JSON.parse(raw) as GeminiBody
          requests.push(body)
          if (process.env.ZAOVRA_GOOGLE_LOOPBACK_DIR)
            await Bun.write(path.join(process.env.ZAOVRA_GOOGLE_LOOPBACK_DIR, "request.json"), raw)
          if (body.contents.at(-1)?.role === "model")
            return Response.json(
              { error: { message: "Requests ending with a model turn are not supported" } },
              { status: 400 },
            )
          return new Response(
            sseEvents({
              candidates: [
                { content: { role: "model", parts: [{ text: "synthetic-nonce-594" }] }, finishReason: "STOP" },
              ],
            }),
            { headers: { "Content-Type": "text/event-stream" } },
          )
        },
      })
      const messages = [
        Message.user("Read the synthetic nonce once, then report it."),
        Message.assistant([
          ToolCallPart.make({
            id: "call_594",
            name: "read",
            input: { path: "synthetic.txt" },
            providerMetadata: { google: { thoughtSignature: "synthetic-signature-594" } },
          }),
        ]),
        Message.tool({
          id: "call_594",
          name: "read",
          result: { type: "content", value: [{ type: "text", text: "synthetic-nonce-594" }] },
        }),
        // SessionRunner appends a final-answer-only assistant notice when its step allowance is reached.
        Message.assistant("The tool allowance is reached. Report observed results; do not call more tools."),
      ]
      const original = JSON.stringify(messages)
      const result = yield* LLMClient.generate(
        LLM.request({
          model: Google.configure({ baseURL: `http://127.0.0.1:${server.port}/v1beta`, apiKey: "synthetic-594" }).model(
            "gemini-test",
          ),
          messages,
          toolChoice: "none",
        }),
      ).pipe(Effect.ensuring(Effect.promise(() => server.stop(true))))
      expect(result.text).toBe("synthetic-nonce-594")
      expect(requests).toHaveLength(1)
      expect(requests[0]!.contents).toEqual([
        { role: "user", parts: [{ text: "Read the synthetic nonce once, then report it." }] },
        {
          role: "model",
          parts: [
            {
              functionCall: { name: "read", args: { path: "synthetic.txt" } },
              thoughtSignature: "synthetic-signature-594",
            },
          ],
        },
        {
          role: "user",
          parts: [{ functionResponse: { name: "read", response: { name: "read", content: "synthetic-nonce-594" } } }],
        },
        {
          role: "model",
          parts: [{ text: "The tool allowance is reached. Report observed results; do not call more tools." }],
        },
        { role: "user", parts: [{ text: "Continue." }] },
      ])
      expect(JSON.stringify(messages)).toBe(original)
    }),
)
