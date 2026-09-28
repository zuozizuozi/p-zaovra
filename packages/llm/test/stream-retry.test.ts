import { expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Stream } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { adjust } from "effect/testing/TestClock"
import { LLM, LLMError, LLMEvent, TransportReason } from "../src"
import { RequestExecutor } from "../src/route"
import { OpenAIChat } from "../src/protocols/openai-chat"
import { runtimeLayer } from "./lib/http"
import { it } from "./lib/effect"

const disconnected = new LLMError({
  module: "test",
  method: "stream",
  reason: new TransportReason({ kind: "StreamReadError", message: "connection reset" }),
})

it.effect("discards uncommitted starts, retries and publishes successful usage once", () =>
  Effect.gen(function* () {
    let attempts = 0
    const events = [LLMEvent.stepStart({ index: 0 }), LLMEvent.textStart({ id: "text" })]
    const run = yield* Stream.unwrap(
      Effect.sync(() => {
        attempts++
        return attempts === 1
          ? Stream.concat(Stream.fromIterable(events), Stream.fail(disconnected))
          : Stream.fromIterable([
              ...events,
              LLMEvent.textDelta({ id: "text", text: "ok" }),
              LLMEvent.stepFinish({ index: 0, reason: "stop", usage: { inputTokens: 10, outputTokens: 2 } }),
            ])
      }),
    ).pipe(RequestExecutor.retryBeforeOutput, Stream.runCollect, Effect.forkChild)
    yield* adjust("70 seconds")
    const result = yield* Fiber.join(run)
    expect(attempts).toBe(2)
    expect(result.filter((e) => e.type === "step-start")).toHaveLength(1)
    expect(result.filter((e) => e.type === "step-finish")).toHaveLength(1)
    expect(result.at(-1)).toMatchObject({ usage: { inputTokens: 10, outputTokens: 2 } })
  }),
)

for (const event of [
  LLMEvent.textDelta({ id: "text", text: "hello" }),
  LLMEvent.reasoningDelta({ id: "reasoning", text: "thinking" }),
  LLMEvent.toolInputStart({ id: "tool", name: "bash" }),
  LLMEvent.reasoningStart({ id: "reasoning", providerMetadata: { provider: { encrypted: "opaque" } } }),
  LLMEvent.stepFinish({ index: 0, reason: "stop", usage: { inputTokens: 10, outputTokens: 2 } }),
]) {
  it.effect(`does not replay after ${event.type}`, () =>
    Effect.gen(function* () {
      let attempts = 0
      const error = yield* Stream.unwrap(
        Effect.sync(() => {
          attempts++
          return Stream.concat(Stream.make(event), Stream.fail(disconnected))
        }),
      ).pipe(RequestExecutor.retryBeforeOutput, Stream.runCollect, Effect.flip)
      expect(error).toBe(disconnected)
      expect(attempts).toBe(1)
    }),
  )
}

for (const recover of [true, false]) {
  it.effect(`HTTP headers and body share retry allowance: recover=${recover}`, () =>
    Effect.gen(function* () {
      let attempts = 0
      const retries: number[] = []
      const waiting = yield* Effect.forEach(Array.from({ length: 5 }), () => Deferred.make<void>())
      const layer = runtimeLayer(
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.sync(() => {
              const respond = (body: ConstructorParameters<typeof Response>[0], init?: ResponseInit) =>
                HttpClientResponse.fromWeb(request, new Response(body, init))
              attempts++
              if (attempts % 2 === 1 && attempts < 6) return respond("busy", { status: 502 })
              if (recover && attempts === 6)
                return respond(
                  'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\ndata: [DONE]\n\n',
                )
              return respond(
                new ReadableStream({
                  start(controller) {
                    controller.error(new Error("reset"))
                  },
                }),
              )
            }),
          ),
        ),
      )
      const run = yield* LLM.generate(
        LLM.request({ model: OpenAIChat.route.model({ id: "test" }), prompt: "hello" }),
      ).pipe(
        Effect.result,
        Effect.provide(layer),
        Effect.provideService(RequestExecutor.RetryObserver, ({ attempt }) =>
          Effect.gen(function* () {
            retries.push(attempt)
            yield* Deferred.succeed(waiting[attempt - 2]!, undefined)
          }),
        ),
        Effect.forkChild,
      )
      yield* Effect.forEach(waiting, (signal) =>
        Effect.gen(function* () {
          yield* Deferred.await(signal)
          yield* adjust("30 seconds")
        }),
      )
      const result = yield* Fiber.join(run)
      expect(attempts).toBe(6)
      expect(retries).toEqual([2, 3, 4, 5, 6])
      expect(result._tag).toBe(recover ? "Success" : "Failure")
      if (result._tag === "Success") expect(result.success.usage).toMatchObject({ inputTokens: 10, outputTokens: 2 })
      if (result._tag === "Failure") expect(result.failure.reason).toMatchObject({ kind: "StreamReadError" })
    }),
  )
}

it.effect("cancellation during backoff does not start another request", () =>
  Effect.gen(function* () {
    let attempts = 0
    const run = yield* Stream.unwrap(
      Effect.sync(() => {
        attempts++
        return Stream.fail(disconnected)
      }),
    ).pipe(RequestExecutor.retryBeforeOutput, Stream.runDrain, Effect.forkChild)
    yield* adjust("1 second")
    yield* Fiber.interrupt(run)
    yield* adjust("70 seconds")
    expect(attempts).toBe(1)
  }),
)
