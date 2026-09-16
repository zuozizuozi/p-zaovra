import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { LLM, LLMEvent, Message } from "../../src"
import { LLMClient } from "../../src/route"
import * as OpenRouter from "../../src/providers/openrouter"
import { it } from "../lib/effect"
import { fixedResponse } from "../lib/http"
import { sseEvents } from "../lib/sse"

describe("OpenRouter", () => {
  it.effect("reassembles unsigned text deltas without growing metadata per token", () =>
    Effect.gen(function* () {
      const model = OpenRouter.configure({ apiKey: "test-key" }).model("test/reasoner")
      const response = yield* LLMClient.generate(LLM.request({ model, prompt: "Think" })).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(
              ...Array.from({ length: 1000 }, () => ({
                choices: [
                  {
                    delta: {
                      reasoning_details: [{ type: "reasoning.text", index: 0, format: "unknown", text: "word " }],
                    },
                  },
                ],
              })),
              { choices: [{ delta: {}, finish_reason: "stop" }] },
            ),
          ),
        ),
      )
      const next = yield* LLMClient.prepare<OpenRouter.OpenRouterBody>(
        LLM.request({ model, messages: [response.message] }),
      )
      expect(next.body.messages[0]).toMatchObject({
        reasoning_details: [{ type: "reasoning.text", index: 0, format: "unknown", text: "word ".repeat(1000) }],
      })
      expect(response.reasoning).toBe("word ".repeat(1000))
    }),
  )
  for (const field of ["reasoning", "reasoning_content"]) {
    it.effect(`streams ${field} and replays it as OpenRouter reasoning`, () =>
      Effect.gen(function* () {
        const model = OpenRouter.configure({ apiKey: "test-key" }).model("test/reasoner")
        const response = yield* LLMClient.generate(LLM.request({ model, prompt: "Think" })).pipe(
          Effect.provide(
            fixedResponse(
              sseEvents(
                { choices: [{ delta: { [field]: "Think " } }] },
                { choices: [{ delta: { [field]: "carefully" } }] },
                { choices: [{ delta: { content: "Done" }, finish_reason: "stop" }] },
              ),
            ),
          ),
        )
        expect(response.reasoning).toBe("Think carefully")
        expect(response.text).toBe("Done")
        expect(response.events[0]?.type).toBe("step-start")
        expect(response.events.filter(LLMEvent.is.finish)).toHaveLength(1)
        const next = yield* LLMClient.prepare<OpenRouter.OpenRouterBody>(
          LLM.request({ model, messages: [response.message] }),
        )
        expect(next.body.messages).toEqual([{ role: "assistant", content: "Done", reasoning: "Think carefully" }])
      }),
    )
  }

  it.effect("preserves ordered signed and encrypted chunks through tool history without duplicating text", () =>
    Effect.gen(function* () {
      const model = OpenRouter.configure({ apiKey: "test-key" }).model("test/reasoner")
      const details = [
        { type: "reasoning.text", index: 0, id: "r1", text: "Inspect", signature: null },
        { type: "reasoning.text", index: 0, text: " file", signature: "signature", format: "anthropic-claude-v1" },
        { type: "reasoning.encrypted", index: 1, id: "r2", data: "opaque-state", format: "google-gemini-v1" },
      ]
      const response = yield* LLMClient.generate(LLM.request({ model, prompt: "Read" })).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(
              { choices: [{ delta: { reasoning: "Inspect", reasoning_details: [details[0]] } }] },
              {
                choices: [
                  {
                    delta: {
                      reasoning: " file",
                      reasoning_details: [details[1]],
                      tool_calls: [{ index: 0, id: "call-1", function: { name: "read", arguments: "{}" } }],
                    },
                  },
                ],
              },
              // Some providers send signatures/encrypted state after tool input begins.
              { choices: [{ delta: { reasoning_details: [details[2]] }, finish_reason: "tool_calls" }] },
            ),
          ),
        ),
      )
      expect(response.reasoning).toBe("Inspect file")
      expect(response.events.filter(LLMEvent.is.reasoningEnd)).toHaveLength(1)
      expect(response.toolCalls).toHaveLength(1)
      const next = yield* LLMClient.prepare<OpenRouter.OpenRouterBody>(
        LLM.request({
          model,
          messages: [
            Message.user("Read"),
            response.message,
            Message.tool({
              type: "tool-result",
              id: response.toolCalls[0]!.id,
              name: "read",
              result: { type: "text", value: "file content" },
            }),
          ],
        }),
      )
      expect(next.body.messages[1]).toEqual({
        role: "assistant",
        content: null,
        reasoning_details: details,
        tool_calls: [{ id: "call-1", type: "function", function: { name: "read", arguments: "{}" } }],
      })
      expect(next.body.messages[2]).toEqual({ role: "tool", tool_call_id: "call-1", content: "file content" })
    }),
  )

  it.effect("retains encrypted-only reasoning and renders details-only text", () =>
    Effect.gen(function* () {
      const model = OpenRouter.configure({ apiKey: "test-key" }).model("test/reasoner")
      for (const detail of [
        { type: "reasoning.encrypted", data: "opaque", index: 0 },
        { type: "reasoning.summary", summary: "Summary", index: 0 },
        { type: "reasoning.text", text: "Thought", index: 0 },
      ]) {
        const response = yield* LLMClient.generate(LLM.request({ model, prompt: "Think" })).pipe(
          Effect.provide(
            fixedResponse(sseEvents({ choices: [{ delta: { reasoning_details: [detail] }, finish_reason: "stop" }] })),
          ),
        )
        expect(response.reasoning).toBe(detail.summary ?? detail.text ?? "")
        const next = yield* LLMClient.prepare<OpenRouter.OpenRouterBody>(
          LLM.request({ model, messages: [response.message] }),
        )
        expect(next.body.messages).toEqual([{ role: "assistant", content: null, reasoning_details: [detail] }])
      }
    }),
  )
  it.effect("prepares OpenRouter models through the OpenAI-compatible Chat route", () =>
    Effect.gen(function* () {
      const model = OpenRouter.configure({ apiKey: "test-key" }).model("openai/gpt-4o-mini")

      expect(model).toMatchObject({
        id: "openai/gpt-4o-mini",
        provider: "openrouter",
        route: { id: "openrouter" },
      })
      expect(model.route.endpoint.baseURL).toBe("https://openrouter.ai/api/v1")

      const prepared = yield* LLMClient.prepare(LLM.request({ model, prompt: "Say hello." }))

      expect(prepared.route).toBe("openrouter")
      expect(prepared.body).toMatchObject({
        model: "openai/gpt-4o-mini",
        messages: [{ role: "user", content: "Say hello." }],
        stream: true,
      })
    }),
  )

  it.effect("applies OpenRouter payload options from the model helper", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model: OpenRouter.configure({
            apiKey: "test-key",
            providerOptions: {
              openrouter: {
                usage: true,
                reasoning: { effort: "high" },
                promptCacheKey: "session_123",
              },
            },
          }).model("anthropic/claude-3.7-sonnet:thinking"),
          prompt: "Think briefly.",
        }),
      )

      expect(prepared.body).toMatchObject({
        usage: { include: true },
        reasoning: { effort: "high" },
        prompt_cache_key: "session_123",
      })
    }),
  )
})
