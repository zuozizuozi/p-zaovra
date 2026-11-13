import { expect } from "bun:test"
import { Effect, Exit } from "effect"
import { LLM, Message, ToolDefinition } from "../../src"
import { OpenAIChat } from "../../src/protocols/openai-chat"
import type { OpenAIChatBody } from "../../src/protocols/openai-chat"
import { OpenAICompatibleChat } from "../../src/protocols/openai-compatible-chat"
import { LLMClient } from "../../src/route"
import { it } from "../lib/effect"
import { fixedResponse } from "../lib/http"
import { sseEvents } from "../lib/sse"

const model = OpenAICompatibleChat.route
  .with({ provider: "gravitex", endpoint: { baseURL: "https://synthetic.invalid/v1" } })
  .model({ id: "deepseek-v4.1-flash-1017" })
const tools = [ToolDefinition.make({ name: "lookup", description: "Lookup", inputSchema: { type: "object" } })]
const options = { deepseek: { thinking: { type: "enabled" as const }, reasoningEffort: "max" as const } }

const emptyTurn = (source = model, thinking = true, reasoning?: string | null) =>
  LLMClient.generate(
    LLM.request({
      model: source,
      tools,
      prompt: "Lookup",
      providerOptions: { deepseek: { thinking: { type: thinking ? "enabled" : "disabled" } } },
    }),
  ).pipe(
    Effect.provide(
      fixedResponse(
        sseEvents(
          {
            choices: [
              {
                delta: {
                  ...(reasoning === undefined ? {} : { reasoning_content: reasoning }),
                  tool_calls: [
                    { index: 0, id: "call_1", type: "function", function: { name: "lookup", arguments: "{}" } },
                  ],
                },
              },
            ],
          },
          { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
          {
            choices: [],
            usage: { prompt_tokens: 10, completion_tokens: 2, completion_tokens_details: { reasoning_tokens: 0 } },
          },
        ),
      ),
    ),
  )

for (const reasoning of [undefined, null, ""]) {
  it.effect("continues only an observed thinking tool turn with " + JSON.stringify(reasoning) + " reasoning", () =>
    Effect.gen(function* () {
      const response = yield* emptyTurn(model, true, reasoning)
      expect(response.reasoning).toBe("")
      expect(response.usage?.reasoningTokens).toBe(0)
      expect(response.message.content.find((part) => part.type === "reasoning")).toEqual({
        type: "reasoning",
        text: "",
        providerMetadata: {
          openaiCompatible: { emptyReasoning: { provider: model.provider, model: model.id, thinking: true } },
        },
      })
      const prepared = yield* LLMClient.prepare<OpenAIChatBody>(
        LLM.request({
          model,
          tools,
          providerOptions: options,
          messages: [
            Message.user("Lookup"),
            response.message,
            Message.tool({ id: "call_1", name: "lookup", result: "found" }),
          ],
        }),
      )
      expect(prepared.body.messages[1]).toEqual({
        role: "assistant",
        content: null,
        reasoning_content: "",
        tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{}" } }],
      })
      expect(prepared.body.messages[2]).toEqual({ role: "tool", tool_call_id: "call_1", content: '"found"' })
      expect(JSON.stringify(prepared.body)).not.toContain("emptyReasoning")
    }),
  )
}

for (const fixture of [
  { name: "same origin after a toggle without a new turn", source: model, thinking: true, allowed: true },
  { name: "changed model", source: model.route.model({ id: "deepseek-previous" }), thinking: true },
  { name: "changed provider", source: model.route.with({ provider: "other" }).model({ id: model.id }), thinking: true },
  { name: "a new non-thinking turn before re-enabling", source: model, thinking: false },
]) {
  it.effect("checks empty reasoning provenance: " + fixture.name, () =>
    Effect.gen(function* () {
      const response = yield* emptyTurn(fixture.source, fixture.thinking)
      const original = JSON.stringify(response.message)
      const request = LLM.request({
        model,
        tools,
        providerOptions: options,
        messages: [response.message, Message.tool({ id: "call_1", name: "lookup", result: "found" })],
      })
      const prepared = yield* LLMClient.prepare<OpenAIChatBody>(request)
      expect(JSON.stringify(response.message)).toBe(original)
      // A turn whose empty reasoning this model did not vouch for cannot be continued in thinking
      // mode. The request goes out without thinking rather than being refused.
      expect(OpenAIChat.thinkingUnavailable(request)).toBe(fixture.allowed !== true)
      expect(prepared.body.thinking).toEqual({ type: fixture.allowed === true ? "enabled" : "disabled" })
      expect("reasoning_effort" in prepared.body && prepared.body.reasoning_effort !== undefined).toBe(
        fixture.allowed === true,
      )
    }),
  )
}

it.effect("continues without thinking a conversation that another model took part in", () =>
  Effect.gen(function* () {
    const request = LLM.request({
      model,
      tools,
      providerOptions: options,
      messages: [
        Message.user("Lookup"),
        Message.assistant([{ type: "tool-call", id: "call_0", name: "lookup", input: {} }]),
        Message.tool({ id: "call_0", name: "lookup", result: "found" }),
        Message.assistant([{ type: "text", text: "Found it." }]),
        Message.user("Now look again"),
      ],
    })
    expect(OpenAIChat.thinkingUnavailable(request)).toBe(true)
    const prepared = yield* LLMClient.prepare<OpenAIChatBody>(request)
    expect(prepared.body.thinking).toEqual({ type: "disabled" })
    expect(prepared.body.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
      "user",
    ])
  }),
)

it.effect("keeps thinking when every earlier turn carries its reasoning", () =>
  Effect.gen(function* () {
    const request = LLM.request({
      model,
      tools,
      providerOptions: options,
      messages: [
        Message.user("Lookup"),
        Message.assistant([
          { type: "reasoning", text: "I should look." },
          { type: "text", text: "Found it." },
        ]),
        Message.user("Now look again"),
      ],
    })
    expect(OpenAIChat.thinkingUnavailable(request)).toBe(false)
    const prepared = yield* LLMClient.prepare<OpenAIChatBody>(request)
    expect(prepared.body.thinking).toEqual({ type: "enabled" })
  }),
)

it.effect("retains original reasoning verbatim beside a trusted empty turn", () =>
  Effect.gen(function* () {
    const reasoning = "  原始推理\nunchanged\t"
    const response = yield* emptyTurn()
    const prepared = yield* LLMClient.prepare<OpenAIChatBody>(
      LLM.request({
        model,
        tools,
        providerOptions: options,
        messages: [
          Message.assistant([
            { type: "reasoning", text: reasoning },
            { type: "text", text: "First" },
          ]),
          Message.user("Continue"),
          response.message,
          Message.tool({ id: "call_1", name: "lookup", result: "found" }),
        ],
      }),
    )
    expect(prepared.body.messages[0]).toEqual({ role: "assistant", content: "First", reasoning_content: reasoning })
    expect(prepared.body.messages[2]).toMatchObject({ role: "assistant", reasoning_content: "" })
  }),
)

for (const reasoning of ["", " \n", "native original"]) {
  it.effect("preserves native reasoning without treating unknown blanks as proof: " + JSON.stringify(reasoning), () =>
    Effect.gen(function* () {
      const messages = [
        Message.make({
          role: "assistant",
          content: "Retained text",
          native: { openaiCompatible: { reasoning_content: reasoning } },
        }),
      ]
      const unguarded = yield* LLMClient.prepare<OpenAIChatBody>(
        LLM.request({ model, providerOptions: options, messages }),
      )
      expect(unguarded.body.messages[0]).toEqual({
        role: "assistant",
        content: "Retained text",
        reasoning_content: reasoning,
      })
      // With tools, a blank that nobody vouched for is not reasoning: thinking is given up for the request.
      const guarded = yield* LLMClient.prepare<OpenAIChatBody>(
        LLM.request({ model, tools, providerOptions: options, messages }),
      )
      expect(guarded.body.thinking).toEqual({ type: reasoning.trim().length > 0 ? "enabled" : "disabled" })
    }),
  )
}

it.effect("does not bless a host closing note or unknown historical assistant", () =>
  Effect.gen(function* () {
    const response = yield* emptyTurn()
    const result = yield* LLMClient.prepare<OpenAIChatBody>(
      LLM.request({
        model,
        tools,
        providerOptions: options,
        messages: [
          response.message,
          Message.tool({ id: "call_1", name: "lookup", result: "found" }),
          Message.assistant("Host closing note"),
        ],
      }),
    )
    expect(result.body.thinking).toEqual({ type: "disabled" })
  }),
)

it.effect("keeps absent reasoning absent when thinking or tools are disabled", () =>
  Effect.gen(function* () {
    for (const request of [
      LLM.request({
        model,
        tools,
        providerOptions: { deepseek: { thinking: { type: "disabled" } } },
        messages: [Message.assistant("No thinking")],
      }),
      LLM.request({ model, providerOptions: options, messages: [Message.assistant("No tools")] }),
      LLM.request({
        model: model.route.model({ id: "generic-chat" }),
        tools,
        messages: [Message.assistant("Other model")],
      }),
    ]) {
      const prepared = yield* LLMClient.prepare<OpenAIChatBody>(request)
      expect(
        prepared.body.messages[0]?.role === "assistant" && prepared.body.messages[0].reasoning_content,
      ).toBeUndefined()
    }
  }),
)

it.effect("keeps returned reasoning even when usage reports zero reasoning tokens", () =>
  Effect.gen(function* () {
    const reasoning = "  原始推理\nunchanged\t"
    const response = yield* emptyTurn(model, true, reasoning)
    expect(response.reasoning).toBe(reasoning)
    expect(response.message.content.find((part) => part.type === "reasoning")?.providerMetadata).toBeUndefined()
    const prepared = yield* LLMClient.prepare<OpenAIChatBody>(
      LLM.request({
        model,
        tools,
        providerOptions: options,
        messages: [response.message, Message.tool({ id: "call_1", name: "lookup", result: "found" })],
      }),
    )
    expect(prepared.body.messages[0]).toMatchObject({ role: "assistant", reasoning_content: reasoning })
  }),
)

it.effect("retains provenance for a real thinking text turn without historical calls", () =>
  Effect.gen(function* () {
    const response = yield* LLMClient.generate(
      LLM.request({ model, tools, providerOptions: options, prompt: "Answer" }),
    ).pipe(
      Effect.provide(
        fixedResponse(
          sseEvents({
            choices: [{ delta: { content: "Upstream answer" }, finish_reason: "stop" }],
            usage: { completion_tokens_details: { reasoning_tokens: 0 } },
          }),
        ),
      ),
    )
    const prepared = yield* LLMClient.prepare<OpenAIChatBody>(
      LLM.request({ model, tools, providerOptions: options, messages: [response.message] }),
    )
    expect(prepared.body.messages[0]).toEqual({ role: "assistant", content: "Upstream answer", reasoning_content: "" })
  }),
)
