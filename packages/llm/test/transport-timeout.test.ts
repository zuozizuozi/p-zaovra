import { expect } from "bun:test"
import { Deferred, Effect, Fiber, Stream } from "effect"
import { adjust } from "effect/testing/TestClock"
import { HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { LLM, LLMError } from "../src"
import { HttpTransport, Framing } from "../src/route"
import { route } from "../src/protocols/openai-chat"
import { OpenAIChat } from "../src/protocols/openai-chat"
import { OpenRouter } from "../src/providers/openrouter"
import { OpenAICompatibleChat } from "../src/protocols/openai-compatible-chat"
import { it } from "./lib/effect"

const request = HttpClientRequest.post("https://provider.test/chat")
const input = LLM.request({ model: route.model({ id: "test" }), prompt: "hello" })

for (const chat of [OpenAIChat.route, OpenRouter.route, OpenAICompatibleChat.route]) {
  for (const started of [false, true]) {
    it.effect(`times out empty JSON deltas ${started ? "after content" : "after headers"} for ${chat.id}`, () =>
      Effect.gen(function* () {
        const bytes = Stream.fromIterable(
          Array.from({ length: 30 }, () =>
            new TextEncoder().encode('data: {"choices":[{"delta":{"role":"assistant","content":""}}]}\n\n'),
          ),
        ).pipe(Stream.mapEffect((chunk) => Effect.sleep("30 seconds").pipe(Effect.as(chunk))))
        const response = HttpClientResponse.fromWeb(
          request,
          new Response(
            yield* Stream.toReadableStreamEffect(
              started
                ? Stream.concat(
                    Stream.make(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n')),
                    bytes,
                  )
                : bytes,
            ),
          ),
        )
        const selected = chat
          .with({ provider: "audit", endpoint: { baseURL: "http://127.0.0.1:1/v1" } })
          .model({ id: "test" })
        const llm = LLM.request({ model: selected, prompt: "hello" })
        const body = yield* selected.route.body.from(llm)
        const prepared = yield* selected.route.prepareTransport(body, llm)
        const run = yield* selected.route
          .streamPrepared(prepared, llm, {
            http: { execute: () => Effect.sleep("100 seconds").pipe(Effect.as(response)) },
          })
          .pipe(Stream.runCollect, Effect.flip, Effect.forkChild)
        yield* adjust("100 seconds")
        yield* adjust("180 seconds")
        expect((yield* Fiber.join(run)).reason).toMatchObject({
          kind: started ? "ProgressTimeout" : "FirstEventTimeout",
        })
      }),
    )
  }
}

it.effect("preserves Chat usage, errors, reasoning, tool fragments and malformed frames", () =>
  Effect.gen(function* () {
    const frames = [
      '{"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":2}}',
      '{"choices":[{"delta":{"reasoning_content":"thinking"}}]}',
      '{"choices":[{"delta":{"reasoning_details":[{"type":"reasoning.encrypted","data":"signed"}]}}]}',
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{"}}]}}]}',
      '{"choices":[{"delta":{},"finish_reason":"stop"}]}',
      '{"error":{"message":"failure"}}',
      "{malformed",
    ]
    const actual = yield* OpenAIChat.framing
      .frame(
        Stream.make(
          new TextEncoder().encode(
            ['{"choices":[{"delta":{}}]}', ...frames].map((frame) => `data: ${frame}\n\n`).join(""),
          ),
        ),
      )
      .pipe(Stream.runCollect)
    expect(actual).toEqual(frames)
  }),
)

it.effect("allows long encrypted-only OpenRouter reasoning while fragments keep arriving", () =>
  Effect.gen(function* () {
    const chunks = [
      ...Array.from({ length: 4 }, (_, index) => ({
        choices: [{ delta: { reasoning_details: [{ type: "reasoning.encrypted", data: `signed-${index}` }] } }],
      })),
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]
    const bytes = Stream.fromIterable(chunks).pipe(
      Stream.mapEffect((chunk) =>
        Effect.sleep("90 seconds").pipe(Effect.as(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`))),
      ),
    )
    const response = HttpClientResponse.fromWeb(request, new Response(yield* Stream.toReadableStreamEffect(bytes)))
    const llm = LLM.request({ model: OpenRouter.route.model({ id: "test" }), prompt: "hello" })
    const prepared = yield* llm.model.route.prepareTransport(yield* llm.model.route.body.from(llm), llm)
    const run = yield* llm.model.route
      .streamPrepared(prepared, llm, {
        http: { execute: () => Effect.succeed(response) },
      })
      .pipe(Stream.runCollect, Effect.forkChild)
    yield* adjust("450 seconds")
    const events = yield* Fiber.join(run)
    expect(events.some((event) => event.type === "finish")).toBe(true)
    expect(JSON.stringify(events)).toContain("signed-3")
  }),
)

it.effect("does not charge slow downstream consumption to the provider timeout", () =>
  Effect.gen(function* () {
    const consuming = yield* Deferred.make<void>()
    const response = HttpClientResponse.fromWeb(request, new Response("data: first\n\ndata: second\n\n"))
    const run = yield* HttpTransport.sseJson
      .with()
      .frames({ request, framing: Framing.sse }, input, { http: { execute: () => Effect.succeed(response) } })
      .pipe(
        Stream.tap(() => Deferred.succeed(consuming, undefined)),
        Stream.mapEffect((frame) => Effect.sleep("200 seconds").pipe(Effect.as(frame))),
        Stream.runCollect,
        Effect.forkChild,
      )
    yield* Deferred.await(consuming)
    yield* adjust("400 seconds")
    expect(yield* Fiber.join(run)).toEqual(["first", "second"])
  }),
)

it.effect("rejects an empty successful HTTP body instead of completing silently", () =>
  Effect.gen(function* () {
    const response = HttpClientResponse.fromWeb(request, new Response(": processing\n\ndata: [DONE]\n\n"))
    const error = yield* HttpTransport.sseJson
      .with()
      .frames({ request, framing: Framing.sse }, input, { http: { execute: () => Effect.succeed(response) } })
      .pipe(Stream.runCollect, Effect.flip)
    expect(error.reason).toMatchObject({ _tag: "InvalidProviderOutput" })
  }),
)

for (const heartbeat of [false, true]) {
  it.effect(`distinguishes ${heartbeat ? "heartbeat-only" : "silent"} response timeout after headers`, () =>
    Effect.gen(function* () {
      const bytes = heartbeat
        ? Stream.fromIterable(Array.from({ length: 20 }, () => new TextEncoder().encode(": processing\n\n"))).pipe(
            Stream.mapEffect((chunk) => Effect.sleep("30 seconds").pipe(Effect.as(chunk))),
          )
        : Stream.never
      const body = yield* Stream.toReadableStreamEffect(bytes)
      const response = HttpClientResponse.fromWeb(
        request,
        new Response(body, {
          headers: { "x-generation-id": "gen-diagnostic" },
        }),
      )
      const run = yield* HttpTransport.sseJson
        .with()
        .frames({ request, framing: Framing.sse }, input, {
          http: { execute: () => Effect.sleep("100 seconds").pipe(Effect.as(response)) },
        })
        .pipe(Stream.runCollect, Effect.flip, Effect.forkChild)
      yield* adjust("100 seconds")
      yield* adjust(heartbeat ? "180 seconds" : "120 seconds")
      const error = yield* Fiber.join(run)
      expect(error).toBeInstanceOf(LLMError)
      expect(error.reason).toMatchObject({ kind: heartbeat ? "FirstEventTimeout" : "StreamIdle" })
      expect(error.reason.message).toContain("gen-diagnostic")
    }),
  )
}

it.effect("cancels waiting response consumption and releases the body", () =>
  Effect.gen(function* () {
    let cancelled = false
    const reading = yield* Deferred.make<void>()
    const bytes = Stream.concat(Stream.make(new TextEncoder().encode("data: {}\n\n")), Stream.never).pipe(
      Stream.ensuring(
        Effect.sync(() => {
          cancelled = true
        }),
      ),
    )
    const body = yield* Stream.toReadableStreamEffect(bytes)
    const response = HttpClientResponse.fromWeb(request, new Response(body))
    const run = yield* HttpTransport.sseJson
      .with()
      .frames({ request, framing: Framing.sse }, input, { http: { execute: () => Effect.succeed(response) } })
      .pipe(
        Stream.tap(() => Deferred.succeed(reading, undefined)),
        Stream.runCollect,
        Effect.scoped,
        Effect.forkChild,
      )
    yield* Deferred.await(reading)
    yield* adjust("1 second")
    yield* Fiber.interrupt(run)
    expect(cancelled).toBe(true)
  }),
)
