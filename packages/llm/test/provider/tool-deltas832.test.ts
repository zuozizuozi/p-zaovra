import { expect } from "bun:test"
import { Effect, Stream } from "effect"
import { LLM, LLMError, LLMEvent } from "../../src"
import { OpenAIChat } from "../../src/protocols/openai-chat"
import { OpenAICompatibleChat } from "../../src/protocols/openai-compatible-chat"
import { Auth, LLMClient } from "../../src/route"
import { it } from "../lib/effect"
import { fixedResponse } from "../lib/http"
import { deltaChunk, usageChunk } from "../lib/openai-chunks"
import { sseEvents } from "../lib/sse"

for (const route of [OpenAIChat.route, OpenAICompatibleChat.route]) {
  const request = LLM.request({
    model: route
      .with({ endpoint: { baseURL: "https://fixture832.invalid/v1" }, auth: Auth.none })
      .model({ id: "glm-fixture832", provider: "fixture" }),
    prompt: "Fixture only",
    tools: [{ name: "lookup", description: "Lookup fixture", inputSchema: { type: "object" } }],
  })

  for (const fixture of [
    { label: "omitted", id: undefined, name: undefined, empty: false },
    { label: "null", id: null, name: null, empty: false },
    { label: "empty-id", id: "", name: undefined, empty: false },
    { label: "empty-name", id: undefined, name: "", empty: false },
    { label: "empty-both", id: "", name: "", empty: false },
    { label: "empty-metadata", id: "", name: "", empty: true },
  ]) {
    it.effect("832 " + route.id + " retains indexed identity for " + fixture.label + " continuation", () =>
      Effect.gen(function* () {
        const body = sseEvents(
          deltaChunk({
            role: "assistant",
            tool_calls: [{ index: 0, id: "call_832", function: { name: "lookup", arguments: '{"query":' } }],
          }),
          deltaChunk({
            tool_calls: [
              {
                index: 0,
                id: fixture.id,
                function: { name: fixture.name, arguments: fixture.empty ? "" : '"safe"' },
              },
            ],
          }),
          deltaChunk({ tool_calls: [{ index: 0, function: { arguments: fixture.empty ? '"safe"}' : "}" } }] }),
          deltaChunk({}, "tool_calls"),
          usageChunk({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }),
        )
        const response = yield* LLMClient.generate(request).pipe(
          Effect.provide(fixedResponse(body, { status: 200, headers: { "content-type": "text/event-stream" } })),
        )
        expect(response.finishReason).toBe("tool-calls")
        expect(response.toolCalls).toMatchObject([{ id: "call_832", name: "lookup", input: { query: "safe" } }])
        expect(response.events.filter(LLMEvent.is.toolInputStart)).toHaveLength(1)
        expect(response.events.filter(LLMEvent.is.toolInputEnd)).toHaveLength(1)
        expect(response.events.filter(LLMEvent.is.toolCall)).toHaveLength(1)
        expect(response.events.filter(LLMEvent.is.finish)).toHaveLength(1)
        expect(
          response.events
            .filter(LLMEvent.is.toolInputDelta)
            .map((event) => event.text)
            .join(""),
        ).toBe('{"query":"safe"}')
        expect(response.usage?.totalTokens).toBe(15)
      }),
    )
  }

  for (const fixture of [
    { label: "no-id", id: undefined, name: "lookup" },
    { label: "no-name", id: "call_832", name: undefined },
    { label: "neither", id: undefined, name: undefined },
    { label: "null", id: null, name: null },
    { label: "empty-id", id: "", name: "lookup" },
    { label: "empty-name", id: "call_832", name: "" },
  ]) {
    it.effect("832 " + route.id + " rejects genuinely missing initial " + fixture.label, () =>
      Effect.gen(function* () {
        const events: LLMEvent[] = []
        const error = yield* LLMClient.stream(request).pipe(
          Stream.runForEach((event) => Effect.sync(() => events.push(event))),
          Effect.provide(
            fixedResponse(
              sseEvents(
                deltaChunk({
                  tool_calls: [{ index: 0, id: fixture.id, function: { name: fixture.name, arguments: "{}" } }],
                }),
                deltaChunk({}, "tool_calls"),
              ),
              { status: 200, headers: { "content-type": "text/event-stream" } },
            ),
          ),
          Effect.flip,
        )
        expect(error).toBeInstanceOf(LLMError)
        expect(error.reason._tag).toBe("InvalidProviderOutput")
        expect(error.reason.message).toBe("OpenAI Chat tool call delta is missing id or name")
        expect(events.filter(LLMEvent.is.toolCall)).toEqual([])
      }),
    )
  }

  it.effect("832 " + route.id + " cannot borrow another index identity", () =>
    Effect.gen(function* () {
      const events: LLMEvent[] = []
      const error = yield* LLMClient.stream(request).pipe(
        Stream.runForEach((event) => Effect.sync(() => events.push(event))),
        Effect.provide(
          fixedResponse(
            sseEvents(
              deltaChunk({
                tool_calls: [{ index: 0, id: "known_832", function: { name: "lookup", arguments: "{}" } }],
              }),
              deltaChunk({ tool_calls: [{ index: 1, id: "", function: { name: "", arguments: "{}" } }] }),
              deltaChunk({}, "tool_calls"),
            ),
          ),
        ),
        Effect.flip,
      )
      expect(error.reason._tag).toBe("InvalidProviderOutput")
      expect(events.filter(LLMEvent.is.toolCall)).toEqual([])
    }),
  )

  it.effect("832 " + route.id + " keeps parallel indexed calls separate with blank continuations", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(
              deltaChunk({
                tool_calls: [
                  { index: 0, id: "first_832", function: { name: "lookup", arguments: '{"n":' } },
                  { index: 1, id: "second_832", function: { name: "lookup", arguments: '{"n":' } },
                ],
              }),
              deltaChunk({
                tool_calls: [
                  { index: 1, id: "", function: { name: "", arguments: "2}" } },
                  { index: 0, id: "", function: { name: "", arguments: "1}" } },
                ],
              }),
              deltaChunk({}, "tool_calls"),
            ),
          ),
        ),
      )
      expect(response.toolCalls).toMatchObject([
        { id: "first_832", name: "lookup", input: { n: 1 } },
        { id: "second_832", name: "lookup", input: { n: 2 } },
      ])
      expect(response.events.filter(LLMEvent.is.toolInputStart)).toHaveLength(2)
      expect(response.events.filter(LLMEvent.is.finish)).toHaveLength(1)
    }),
  )
}
