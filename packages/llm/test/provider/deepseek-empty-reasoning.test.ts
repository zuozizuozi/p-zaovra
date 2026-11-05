import { expect } from "bun:test"
import { Effect } from "effect"
import { LLM, Message, ToolCallPart, ToolDefinition } from "../../src"
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

for (const reasoning of [undefined, ""]) {
  it.effect(`continues a provider tool turn with ${reasoning === undefined ? "omitted" : "empty"} reasoning`, () =>
    Effect.gen(function* () {
      const delta = {
        ...(reasoning === undefined ? {} : { reasoning_content: reasoning }),
        tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "lookup", arguments: "{}" } }],
      }
      const response = yield* LLMClient.generate(
        LLM.request({ model, tools, prompt: "Lookup", providerOptions: options }),
      ).pipe(
        Effect.provide(
          fixedResponse(sseEvents({ choices: [{ delta }] }, { choices: [{ delta: {}, finish_reason: "tool_calls" }] })),
        ),
      )
      expect(response.reasoning).toBe("")
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
    }),
  )
}

it.effect("retains original reasoning verbatim beside a reasoning-free assistant turn", () =>
  Effect.gen(function* () {
    const reasoning = "  原始推理\nunchanged\t"
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
          Message.assistant(ToolCallPart.make({ id: "call_1", name: "lookup", input: {} })),
          Message.tool({ id: "call_1", name: "lookup", result: "found" }),
          Message.assistant("Host closing note"),
        ],
      }),
    )
    expect(prepared.body.messages[0]).toEqual({ role: "assistant", content: "First", reasoning_content: reasoning })
    expect(prepared.body.messages[2]).toMatchObject({ role: "assistant", reasoning_content: "" })
    expect(prepared.body.messages[4]).toEqual({
      role: "assistant",
      content: "Host closing note",
      reasoning_content: "",
    })
  }),
)

for (const reasoning of ["", " \n", "native original"]) {
  it.effect(`preserves an explicit native reasoning field ${JSON.stringify(reasoning)}`, () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIChatBody>(
        LLM.request({
          model,
          tools,
          providerOptions: options,
          messages: [
            Message.make({
              role: "assistant",
              content: "Retained text",
              native: { openaiCompatible: { reasoning_content: reasoning } },
            }),
          ],
        }),
      )
      expect(prepared.body.messages[0]).toEqual({
        role: "assistant",
        content: "Retained text",
        reasoning_content: reasoning,
      })
    }),
  )
}

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
