import { expect } from "bun:test"
import { Effect, Stream } from "effect"
import { LLM, LLMEvent } from "../../src"
import { Auth, LLMClient } from "../../src/route"
import { OpenAIChat } from "../../src/protocols/openai-chat"
import { it } from "../lib/effect"
import { fixedResponse } from "../lib/http"
import { deltaChunk, usageChunk } from "../lib/openai-chunks"
import { sseEvents } from "../lib/sse"

const request = LLM.request({
  model: OpenAIChat.route
    .with({ endpoint: { baseURL: "https://model730.test" }, auth: Auth.bearer("synthetic730") })
    .model({ id: "requested-alias" }),
  prompt: "Synthetic response model provenance",
})

for (const choices of [[{ delta: { role: "assistant" } }], [{ delta: {} }], []]) {
  it.effect("730 retains upstream model carried only by initial metadata frame " + JSON.stringify(choices), () =>
    Effect.gen(function* () {
      const events = yield* LLMClient.stream(request).pipe(
        Stream.runCollect,
        Effect.provide(
          fixedResponse(
            sseEvents(
              { model: "actual-wire-730", system_fingerprint: "fp730", choices },
              deltaChunk({ content: "Synthetic answer" }, "stop"),
              usageChunk({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }),
            ),
          ),
        ),
      )
      expect(events.find(LLMEvent.is.stepFinish)?.providerMetadata?.openai).toMatchObject({
        model: "actual-wire-730",
        system_fingerprint: "fp730",
      })
      expect(events.filter(LLMEvent.is.finish)).toHaveLength(1)
      expect(events.filter(LLMEvent.is.stepFinish)).toHaveLength(1)
      expect(
        events
          .filter(LLMEvent.is.textDelta)
          .map((event) => event.text)
          .join(""),
      ).toBe("Synthetic answer")
    }),
  )
}

it.effect("730 repeated identity keepalives remain no-ops and framing state is per subscription", () =>
  Effect.gen(function* () {
    const first = { model: "wire-a", system_fingerprint: "fp-a", choices: [{ delta: { role: "assistant" } }] }
    const changed = { ...first, model: "wire-b" }
    const body = sseEvents(
      first,
      first,
      { ...first, choices: [] },
      changed,
      { ...deltaChunk({ content: "OK" }), model: "wire-b", system_fingerprint: "fp-a" },
      changed,
      deltaChunk({}, "stop"),
      usageChunk({ prompt_tokens: 1, completion_tokens: 1 }),
    )
    const frames = OpenAIChat.framing.frame(Stream.make(new TextEncoder().encode(body)))
    const one = yield* Stream.runCollect(frames)
    const two = yield* Stream.runCollect(frames)
    expect(one).toHaveLength(5)
    expect(two).toEqual(one)
    expect(one[0]).toContain("wire-a")
    expect(one[1]).toContain("wire-b")
    const repeated = OpenAIChat.framing.frame(Stream.make(new TextEncoder().encode(sseEvents(first, first))))
    const captured = yield* Stream.runCollect(repeated)
    expect(captured).toHaveLength(1)
    expect(yield* Stream.runCollect(repeated)).toEqual(captured)
  }),
)

it.effect("730 never substitutes requested alias when upstream model is absent", () =>
  Effect.gen(function* () {
    const events = yield* LLMClient.stream(request).pipe(
      Stream.runCollect,
      Effect.provide(fixedResponse(sseEvents(deltaChunk({ content: "No identity" }, "stop")))),
    )
    expect(events.find(LLMEvent.is.stepFinish)?.providerMetadata?.openai?.model).toBeUndefined()
    expect(events.filter(LLMEvent.is.finish)).toHaveLength(1)
  }),
)
