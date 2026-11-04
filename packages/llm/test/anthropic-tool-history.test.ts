import { describe, expect } from "bun:test"
import { Effect, Schema } from "effect"
import { LLM, Message, ToolCallPart, ToolDefinition } from "../src"
import { Auth, LLMClient } from "../src/route"
import { AnthropicMessages } from "../src/protocols/anthropic-messages"
import { BedrockConverse } from "../src/protocols/bedrock-converse"
import { AmazonBedrock } from "../src/providers"
import { it } from "./lib/effect"
import { fixedResponse } from "./lib/http"
import { sseEvents } from "./lib/sse"

const model = AnthropicMessages.route
  .with({ auth: Auth.header("x-api-key", "fixture-only") })
  .model({ id: "claude-sonnet-4-5" })

const tool = ToolDefinition.make({
  name: "lookup",
  description: "Look up a fixture value.",
  inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
})

const history = [
  Message.user("Look up the value."),
  Message.assistant([ToolCallPart.make({ id: "lookup-1", name: "lookup", input: { key: "fixture" } })]),
  Message.tool({ id: "lookup-1", name: "lookup", result: { value: "fixture-result" } }),
]

describe("545 Anthropic tool history", () => {
  it.effect("retains provided definitions with none and preserves the original tool blocks", () =>
    Effect.gen(function* () {
      const request = LLM.request({ model, messages: history, tools: [tool], toolChoice: "none", cache: "none" })
      const prepared = yield* LLMClient.prepare<AnthropicMessages.AnthropicMessagesBody>(request)
      expect(prepared.body.tool_choice).toEqual({ type: "none" })
      expect(prepared.body.tools).toEqual([
        { name: "lookup", description: tool.description, input_schema: tool.inputSchema },
      ])
      expect(prepared.body.messages[1]?.content).toEqual([
        { type: "tool_use", id: "lookup-1", name: "lookup", input: { key: "fixture" } },
      ])
      expect(prepared.body.messages[2]?.content).toEqual([
        { type: "tool_result", tool_use_id: "lookup-1", content: '{"value":"fixture-result"}' },
      ])
      expect(request.tools).toEqual([tool])
      expect(request.messages).toEqual(history)
    }),
  )

  for (const choice of ["none", undefined] as const) {
    it.effect(`adds history-only definitions without enabling tools when the caller has no catalog (${choice})`, () =>
      Effect.gen(function* () {
        const request = LLM.request({ model, messages: history, tools: [], toolChoice: choice, cache: "none" })
        const prepared = yield* LLMClient.prepare<AnthropicMessages.AnthropicMessagesBody>(request)
        expect(prepared.body.tool_choice).toEqual({ type: "none" })
        expect(prepared.body.tools?.map((value) => value.name)).toEqual(["lookup"])
        expect(prepared.body.tools?.[0]?.input_schema.type).toBe("object")
        expect(prepared.body.messages[1]?.content[0]?.type).toBe("tool_use")
        expect(prepared.body.messages[2]?.content[0]?.type).toBe("tool_result")
        expect(request.tools).toEqual([])
        expect(request.messages).toEqual(history)
      }),
    )
  }

  it.effect("does not introduce definitions or tool_choice for a fresh text-only request", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<AnthropicMessages.AnthropicMessagesBody>(
        LLM.request({ model, prompt: "hello", tools: [], cache: "none" }),
      )
      expect(prepared.body.tools).toBeUndefined()
      expect(prepared.body.tool_choice).toBeUndefined()
    }),
  )

  it.effect("keeps active tools and named tool choice unchanged", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<AnthropicMessages.AnthropicMessagesBody>(
        LLM.request({
          model,
          messages: history,
          tools: [tool],
          toolChoice: { type: "tool", name: "lookup" },
          cache: "none",
        }),
      )
      expect(prepared.body.tool_choice).toEqual({ type: "tool", name: "lookup" })
      expect(prepared.body.tools).toEqual([
        { name: "lookup", description: tool.description, input_schema: tool.inputSchema },
      ])
    }),
  )

  it.effect("Bedrock text-only continuation has no toolConfig or structured tool blocks", () =>
    Effect.gen(function* () {
      const request = LLM.request({
        model: AmazonBedrock.configure({ baseURL: "https://bedrock-runtime.test", apiKey: "fixture-only" }).model(
          "anthropic.fixture",
        ),
        messages: history,
        tools: [],
        toolChoice: "none",
        cache: "none",
      })
      const prepared = yield* LLMClient.prepare<BedrockConverse.BedrockConverseBody>(request)
      expect(prepared.body.toolConfig).toBeUndefined()
      expect(prepared.body.messages.every((message) => message.content.every((part) => "text" in part))).toBe(true)
      expect(JSON.stringify(prepared.body.messages)).toContain("lookup-1")
      expect(JSON.stringify(prepared.body.messages)).toContain("fixture-result")
      expect(request.messages).toEqual(history)
    }),
  )

  it.effect(
    "round-trips ordered redacted and signed thinking through response collection and message serialization",
    () =>
      Effect.gen(function* () {
        const response = yield* LLMClient.generate(
          LLM.request({ model, prompt: "fixture", tools: [tool], cache: "none" }),
        ).pipe(
          Effect.provide(
            fixedResponse(
              sseEvents(
                { type: "message_start", message: { model: "claude-sonnet-4-5" } },
                {
                  type: "content_block_start",
                  index: 0,
                  content_block: { type: "thinking", thinking: "signed", signature: "signature-one" },
                },
                { type: "content_block_stop", index: 0 },
                {
                  type: "content_block_start",
                  index: 1,
                  content_block: { type: "redacted_thinking", data: "opaque+/one==" },
                },
                { type: "content_block_stop", index: 1 },
                {
                  type: "content_block_start",
                  index: 2,
                  content_block: { type: "thinking", thinking: "", signature: "signature-two" },
                },
                { type: "content_block_stop", index: 2 },
                { type: "content_block_start", index: 3, content_block: { type: "redacted_thinking", data: "" } },
                { type: "content_block_stop", index: 3 },
                {
                  type: "content_block_start",
                  index: 4,
                  content_block: { type: "tool_use", id: "lookup-1", name: "lookup", input: {} },
                },
                {
                  type: "content_block_delta",
                  index: 4,
                  delta: { type: "input_json_delta", partial_json: '{"key":"fixture"}' },
                },
                { type: "content_block_stop", index: 4 },
                { type: "message_delta", delta: { stop_reason: "tool_use" } },
                { type: "message_stop" },
              ),
            ),
          ),
        )
        const assistant = Schema.decodeUnknownSync(Schema.toCodecIso(Message))(
          JSON.parse(JSON.stringify(response.message)),
        )
        expect(assistant).toBeInstanceOf(Message)
        expect(assistant.content.map((part) => part.type)).toEqual([
          "reasoning",
          "reasoning",
          "reasoning",
          "reasoning",
          "tool-call",
        ])
        expect(response.events.filter((event) => event.type === "reasoning-end")).toHaveLength(4)
        const prepared = yield* LLMClient.prepare<AnthropicMessages.AnthropicMessagesBody>(
          LLM.request({
            model,
            tools: [],
            toolChoice: "none",
            cache: "none",
            messages: [Message.user("fixture"), assistant, history[2]!],
          }),
        )
        expect(prepared.body.messages[1]?.content).toEqual([
          { type: "thinking", thinking: "signed", signature: "signature-one" },
          { type: "redacted_thinking", data: "opaque+/one==" },
          { type: "thinking", thinking: "", signature: "signature-two" },
          { type: "redacted_thinking", data: "" },
          { type: "tool_use", id: "lookup-1", name: "lookup", input: { key: "fixture" } },
        ])
        expect(prepared.body.tool_choice).toEqual({ type: "none" })
      }),
  )
})
