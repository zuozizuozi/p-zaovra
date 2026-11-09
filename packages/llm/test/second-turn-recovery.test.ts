import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { LLM, Message } from "../src"
import { Auth, LLMClient, RequestExecutor } from "../src/route"
import { OpenAIResponses } from "../src/protocols/openai-responses"
import { OpenAIChat } from "../src/protocols/openai-chat"
import { testEffect } from "./lib/effect"
import { sseEvents } from "./lib/sse"

for (const protocol of ["responses", "chat"] as const)
  testEffect(LLMClient.layer.pipe(Layer.provide(RequestExecutor.fetchLayer))).live(
    `776 actual HTTP ${protocol}: successful first turn, second-turn cipher rejection, one recovery`,
    () =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          const sent: { body: Record<string, unknown>; auth: string | null }[] = []
          const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            async fetch(incoming) {
              sent.push({ body: await incoming.json(), auth: incoming.headers.get("authorization") })
              if (sent.length === 2)
                return Response.json(
                  { error: { code: "invalid_encrypted_content", message: "synthetic cipher rejected" } },
                  { status: 400 },
                )
              const first = sent.length === 1
              return new Response(
                protocol === "responses"
                  ? sseEvents(
                      ...(first
                        ? [
                            { type: "response.reasoning_summary_text.delta", item_id: "rs_1", delta: "summary" },
                            {
                              type: "response.output_item.done",
                              item: {
                                type: "reasoning",
                                id: "rs_1",
                                encrypted_content: "SYNTHETIC_CIPHER_776",
                                summary: [{ type: "summary_text", text: "summary" }],
                              },
                            },
                          ]
                        : []),
                      {
                        type: "response.output_text.delta",
                        item_id: first ? "msg_1" : "msg_2",
                        delta: first ? "first answer" : "recovered answer",
                      },
                      {
                        type: "response.completed",
                        response: {
                          id: first ? "resp_1" : "resp_2",
                          status: "completed",
                          output: [],
                          usage: { input_tokens: 10, output_tokens: 2 },
                        },
                      },
                    )
                  : sseEvents(
                      ...(first
                        ? [
                            {
                              choices: [
                                { delta: { reasoning_content: "summary", encrypted_content: "SYNTHETIC_CIPHER_776" } },
                              ],
                            },
                          ]
                        : []),
                      { choices: [{ delta: { content: first ? "first answer" : "recovered answer" } }] },
                      { choices: [{ delta: {}, finish_reason: "stop" }] },
                    ),
                { headers: { "content-type": "text/event-stream" } },
              )
            },
          })
          return { server, sent }
        }),
        ({ server, sent }) =>
          Effect.gen(function* () {
            const route = protocol === "responses" ? OpenAIResponses.route : OpenAIChat.route
            const model = route
              .with({ endpoint: { baseURL: server.url.toString() }, auth: Auth.bearer("synthetic-776") })
              .model({ id: "synthetic" })
            const options = {
              providerOptions: { openai: { reasoningEffort: "high", include: ["reasoning.encrypted_content"] } },
              generation: { maxTokens: 128000 },
            }
            const first = yield* LLMClient.generate(
              LLM.request({ model, messages: [Message.user("first question")], ...options }),
            )
            expect(first.message.content).toContainEqual(
              expect.objectContaining({ type: "text", text: "first answer" }),
            )
            const next = LLM.request({
              model,
              messages: [Message.user("first question"), first.message, Message.user("second question")],
              ...options,
            })
            const original = (yield* LLMClient.prepare(next)).body
            expect(JSON.stringify(original)).toContain("SYNTHETIC_CIPHER_776")
            const second = yield* LLMClient.generate(next)
            expect(second.message.content).toContainEqual(
              expect.objectContaining({ type: "text", text: "recovered answer" }),
            )
            expect(sent).toHaveLength(3)
            expect(JSON.stringify(sent[1]?.body)).toContain("SYNTHETIC_CIPHER_776")
            expect(JSON.stringify(sent[2]?.body)).not.toContain("SYNTHETIC_CIPHER_776")
            expect(JSON.stringify(sent[2]?.body)).toContain("first answer")
            expect(JSON.stringify(sent[2]?.body)).toContain("second question")
            expect(sent.map((item) => item.auth)).toEqual(Array(3).fill("Bearer synthetic-776"))
            for (const item of sent) {
              expect(item.body[protocol === "responses" ? "max_output_tokens" : "max_tokens"]).toBe(128000)
              expect(protocol === "responses" ? item.body.reasoning : item.body.reasoning_effort).toEqual(
                protocol === "responses" ? { effort: "high" } : "high",
              )
            }
            expect((yield* LLMClient.prepare(next)).body).toEqual(original)
          }),
        ({ server }) =>
          Effect.sync(() => {
            server.stop(true)
          }),
      ),
  )
