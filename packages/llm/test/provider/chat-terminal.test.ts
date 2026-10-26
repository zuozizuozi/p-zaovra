import { expect } from "bun:test"
import { Effect, Stream } from "effect"
import { LLM, LLMEvent } from "../../src"
import { Auth, LLMClient } from "../../src/route"
import { OpenAIChat } from "../../src/protocols/openai-chat"
import { OpenRouter } from "../../src/providers/openrouter"
import { it } from "../lib/effect"
import { fixedResponse } from "../lib/http"
import { sseEvents } from "../lib/sse"

const models = [
  [
    "Chat",
    OpenAIChat.route
      .with({ endpoint: { baseURL: "https://chat.test" }, auth: Auth.bearer("test") })
      .model({ id: "test" }),
  ],
  ["OpenRouter", OpenRouter.configure({ apiKey: "test" }).model("test/reasoner")],
] as const
for (const [name, model] of models) {
  for (const finish of ["stop", "tool_calls", "length"])
    it.effect(`378 ${name} keeps error terminal before late usage/text/finish after ${finish}`, () =>
      Effect.gen(function* () {
        const body = sseEvents(
          {
            choices: [
              {
                delta: {
                  reasoning_content: "before",
                  tool_calls: [{ index: 0, id: "call", function: { name: "lookup", arguments: "{}" } }],
                },
              },
            ],
          },
          { choices: [{ delta: {}, finish_reason: finish }] },
          { choices: [], error: { message: "terminal fixture", type: "invalid_request_error" } },
          { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
          { choices: [{ delta: { content: "late text", reasoning: "late reasoning" }, finish_reason: "stop" }] },
        )
        const request = LLM.request({ model, prompt: "test" })
        const events = Array.from(
          yield* LLMClient.stream(request).pipe(Stream.runCollect, Effect.provide(fixedResponse(body))),
        )
        const failed = events.findIndex(LLMEvent.is.providerError)
        expect(failed).toBeGreaterThanOrEqual(0)
        expect(events.slice(failed + 1)).toEqual([])
        expect(events.filter(LLMEvent.is.toolCall)).toEqual([])
        expect(events.filter(LLMEvent.is.finish)).toEqual([])
        const response = yield* LLMClient.generate(request).pipe(Effect.provide(fixedResponse(body)))
        expect(response.finishReason).toBe("error")
        expect(response.toolCalls).toEqual([])
      }),
    )

  it.effect(`378 ${name} keeps normal tools and trailing usage`, () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(LLM.request({ model, prompt: "test" })).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(
              {
                choices: [
                  { delta: { tool_calls: [{ index: 0, id: "call", function: { name: "lookup", arguments: "{}" } }] } },
                ],
              },
              { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
            ),
          ),
        ),
      )
      expect(response.toolCalls).toHaveLength(1)
      expect(response.finishReason).toBe("tool-calls")
      expect(response.usage?.totalTokens).toBe(12)
      expect(response.events.filter(LLMEvent.is.finish)).toHaveLength(1)
    }),
  )
}

it.effect("378 Chat parser itself preserves failed state when stepped again", () =>
  Effect.gen(function* () {
    const request = LLM.request({ model: models[0][1], prompt: "test" })
    const [failed] = yield* OpenAIChat.protocol.stream.step(OpenAIChat.protocol.stream.initial(request), {
      choices: [],
      error: { message: "failed" },
    })
    const [late, events] = yield* OpenAIChat.protocol.stream.step(failed, {
      choices: [{ delta: { content: "late" }, finish_reason: "stop" }],
    })
    expect(events).toEqual([])
    expect(OpenAIChat.protocol.stream.onHalt?.(late)).toEqual([])
  }),
)

it.effect("378 OpenRouter parser itself preserves failed state when stepped again", () =>
  Effect.gen(function* () {
    const request = LLM.request({ model: models[1][1], prompt: "test" })
    const [failed] = yield* OpenRouter.protocol.stream.step(OpenRouter.protocol.stream.initial(request), {
      choices: [],
      error: { message: "failed" },
    })
    const [late, events] = yield* OpenRouter.protocol.stream.step(failed, {
      choices: [{ delta: { reasoning: "late", content: "late" }, finish_reason: "stop" }],
    })
    expect(events).toEqual([])
    expect(OpenRouter.protocol.stream.onHalt?.(late)).toEqual([])
  }),
)
