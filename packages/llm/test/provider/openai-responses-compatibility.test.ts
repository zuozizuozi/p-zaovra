import { expect } from "bun:test"
import { Effect } from "effect"
import { LLM, type LLMResponse } from "../../src"
import { OpenAIResponses } from "../../src/protocols/openai-responses"
import { Auth, LLMClient } from "../../src/route"
import { it } from "../lib/effect"
import { fixedResponse } from "../lib/http"
import { sseEvents } from "../lib/sse"

const request = LLM.request({
  model: OpenAIResponses.route
    .with({ provider: "gravitex", endpoint: { baseURL: "https://responses.test/v1" }, auth: Auth.bearer("fixture") })
    .model({ id: "qwen3.7-flash" }),
  prompt: "Use the supplied stream fixture.",
})

it.effect("ignores unknown event payloads without validating fields owned by other event types", () =>
  Effect.gen(function* () {
    const response = yield* LLMClient.generate(request).pipe(
      Effect.provide(
        fixedResponse(
          sseEvents(
            {
              type: "response.future_event",
              delta: { text: "not a text delta" },
              item: { type: "future_item", id: null },
              response: null,
              code: 17,
            },
            { type: "response.output_text.delta", item_id: "message", delta: "Hello" },
            {
              type: "response.completed",
              response: { id: "response", usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } },
            },
          ),
        ),
      ),
    )

    expect(response.text).toBe("Hello")
    expect(response.usage?.totalTokens).toBe(3)
    expect(response.events.filter((event) => event.type === "provider-error")).toEqual([])
    expect(response.events.filter((event) => event.type === "finish")).toHaveLength(1)
  }),
)

it.effect("rejects a malformed known text delta instead of ignoring it as an unknown event", () =>
  Effect.gen(function* () {
    const error = yield* LLMClient.generate(request).pipe(
      Effect.provide(
        fixedResponse(sseEvents({ type: "response.output_text.delta", item_id: "message", delta: { text: "bad" } })),
      ),
      Effect.flip,
    )

    expect(error.reason).toMatchObject({ _tag: "InvalidProviderOutput" })
  }),
)

it.effect("rejects events without a string type", () =>
  Effect.gen(function* () {
    const error = yield* LLMClient.generate(request).pipe(
      Effect.provide(fixedResponse(sseEvents({ type: 17, delta: "bad" }))),
      Effect.flip,
    )

    expect(error.reason).toMatchObject({ _tag: "InvalidProviderOutput" })
  }),
)

it.effect("preserves an in-progress tool call across an ignored event", () =>
  Effect.gen(function* () {
    const response = yield* LLMClient.generate(request).pipe(
      Effect.provide(
        fixedResponse(
          sseEvents(
            {
              type: "response.output_item.added",
              item: { type: "function_call", id: "item", call_id: "call", name: "lookup", arguments: "" },
            },
            { type: "response.function_call_arguments.delta", item_id: "item", delta: '{"query":' },
            { type: "response.future_event", item_id: 1, delta: null, error: ["unrelated"] },
            { type: "response.function_call_arguments.delta", item_id: "item", delta: '"weather"}' },
            {
              type: "response.output_item.done",
              item: {
                type: "function_call",
                id: "item",
                call_id: "call",
                name: "lookup",
                arguments: '{"query":"weather"}',
              },
            },
            { type: "response.completed", response: { id: "response" } },
          ),
        ),
      ),
    )

    expect(response.events.filter((event) => event.type === "tool-call")).toMatchObject([
      { id: "call", name: "lookup", input: { query: "weather" } },
    ])
    expect(response.events.filter((event) => event.type === "tool-input-end")).toHaveLength(1)
    expect(response.events.filter((event) => event.type === "finish")).toMatchObject([{ reason: "tool-calls" }])
  }),
)

it.effect("rejects malformed usage in a known terminal event", () =>
  Effect.gen(function* () {
    const error = yield* LLMClient.generate(request).pipe(
      Effect.provide(
        fixedResponse(sseEvents({ type: "response.completed", response: { usage: { input_tokens: "bad" } } })),
      ),
      Effect.flip,
    )

    expect(error.reason).toMatchObject({ _tag: "InvalidProviderOutput" })
  }),
)

it.effect("parses the Qwen reasoning items whose optional status is null", () =>
  Effect.gen(function* () {
    const body = yield* Effect.promise(() =>
      Bun.file(new URL("../fixtures/openai-responses/qwen-null-status.sse", import.meta.url)).text(),
    )
    const response = yield* LLMClient.generate(request).pipe(Effect.provide(fixedResponse(body)))

    expectQwenResponse(response)
  }),
)

if (process.env.ZAOVRA_RESPONSES674_SSE) {
  it.effect("replays the complete archived Qwen SSE through the native Responses route", () =>
    Effect.gen(function* () {
      const body = yield* Effect.promise(() => Bun.file(process.env.ZAOVRA_RESPONSES674_SSE!).text())
      const response = yield* LLMClient.generate(request).pipe(Effect.provide(fixedResponse(body)))
      expectQwenResponse(response)
    }),
  )
}

function expectQwenResponse(response: LLMResponse) {
  expect(response.reasoning).toBe(
    "The user wants me to run a simple shell command and then reply DONE. Let me execute that command.",
  )
  expect(response.events.filter((event) => event.type === "tool-call")).toMatchObject([
    {
      id: "call_ad9de1acbb9b4ebab5027eb3",
      name: "bash",
      input: { command: "printf R5_SSE_CAPTURE674 > r5-sse-capture674.txt; cat r5-sse-capture674.txt" },
    },
  ])
  expect(response.usage).toMatchObject({
    inputTokens: 9605,
    outputTokens: 80,
    reasoningTokens: 21,
    cacheReadInputTokens: 0,
    totalTokens: 9685,
  })
  expect(response.events.filter((event) => event.type === "provider-error")).toEqual([])
  expect(response.events.filter((event) => event.type === "finish")).toMatchObject([{ reason: "tool-calls" }])
}

it.effect("rejects non-string non-null item status", () =>
  Effect.gen(function* () {
    const error = yield* LLMClient.generate(request).pipe(
      Effect.provide(
        fixedResponse(
          sseEvents({ type: "response.output_item.added", item: { type: "reasoning", id: "item", status: 17 } }),
        ),
      ),
      Effect.flip,
    )

    expect(error.reason).toMatchObject({ _tag: "InvalidProviderOutput" })
  }),
)
