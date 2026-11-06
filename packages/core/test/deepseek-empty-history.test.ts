import { expect } from "bun:test"
import { LLM, LLMEvent, ToolDefinition } from "@zaovra-ai/llm"
import { LLMClient } from "@zaovra-ai/llm/route"
import { OpenAICompatibleChat } from "@zaovra-ai/llm/protocols/openai-compatible-chat"
import type { OpenAIChatBody } from "@zaovra-ai/llm/protocols/openai-chat"
import { DateTime, Effect, Exit, Layer, Stream } from "effect"
import { Database } from "@zaovra-ai/core/database/database"
import { AppNodeBuilder } from "@zaovra-ai/core/effect/app-node-builder"
import { LayerNode } from "@zaovra-ai/core/effect/layer-node"
import { EventV2 } from "@zaovra-ai/core/event"
import { Location } from "@zaovra-ai/core/location"
import { ModelV2 } from "@zaovra-ai/core/model"
import { ProviderV2 } from "@zaovra-ai/core/provider"
import { ProjectV2 } from "@zaovra-ai/core/project"
import { AbsolutePath } from "@zaovra-ai/core/schema"
import { SessionV2 } from "@zaovra-ai/core/session"
import { SessionEvent } from "@zaovra-ai/core/session/event"
import { SessionExecution } from "@zaovra-ai/core/session/execution"
import { SessionProjector } from "@zaovra-ai/core/session/projector"
import { SessionStore } from "@zaovra-ai/core/session/store"
import { createLLMEventPublisher } from "@zaovra-ai/core/session/runner/publish-llm-event"
import { toLLMMessages } from "@zaovra-ai/core/session/runner/to-llm-message"
import { fixedResponse } from "../../llm/test/lib/http"
import { sseEvents } from "../../llm/test/lib/sse"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SessionStore.node, SessionV2.node]),
    [
      [
        ProjectV2.node,
        Layer.succeed(
          ProjectV2.Service,
          ProjectV2.Service.of({
            resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
            directories: () => Effect.succeed([]),
            commit: () => Effect.void,
          }),
        ),
      ],
      [SessionExecution.node, SessionExecution.noopLayer],
    ],
  ),
)

const model = OpenAICompatibleChat.route
  .with({
    provider: "gravitex",
    endpoint: { baseURL: "https://synthetic.invalid/v1" },
    providerOptions: { deepseek: { thinking: { type: "enabled" } } },
  })
  .model({ id: "deepseek-fixture" })
const tools = [ToolDefinition.make({ name: "lookup", description: "Lookup", inputSchema: { type: "object" } })]

for (const fixture of [
  { name: "same thinking origin", allowed: true },
  { name: "changed provider", provider: "other" },
  { name: "changed model", model: "deepseek-previous" },
  { name: "new non-thinking turn", disabled: true },
]) {
  it.effect("676 empty reasoning stream to durable history to wire: " + fixture.name, () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const store = yield* SessionStore.Service
      const created = yield* session.create({
        location: Location.Ref.make({ directory: AbsolutePath.make("/synthetic") }),
      })
      const source = OpenAICompatibleChat.route
        .with({
          provider: fixture.provider ?? model.provider,
          endpoint: { baseURL: "https://synthetic.invalid/v1" },
          providerOptions: { deepseek: { thinking: { type: fixture.disabled ? "disabled" : "enabled" } } },
        })
        .model({ id: fixture.model ?? model.id })
      const publisher = createLLMEventPublisher(events, {
        sessionID: created.id,
        agent: "build",
        model: { id: ModelV2.ID.make(String(source.id)), providerID: ProviderV2.ID.make(String(source.provider)) },
        inputSequence: 0,
        contextEpoch: 0,
      })
      yield* LLMClient.stream(LLM.request({ model: source, tools, prompt: "Lookup" })).pipe(
        Stream.runForEach(publisher.publish),
        Effect.provide(
          fixedResponse(
            sseEvents(
              {
                choices: [
                  {
                    delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "lookup", arguments: "{}" } }] },
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
      yield* publisher.publish(
        LLMEvent.toolResult({ id: "call-1", name: "lookup", result: { type: "text", value: "retained result" } }),
      )
      yield* events.publish(SessionEvent.Step.Ended, {
        sessionID: created.id,
        assistantMessageID: yield* publisher.startAssistant(),
        timestamp: yield* DateTime.now,
        finish: "tool-calls",
        cost: 0,
        tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
      })
      // Read the durable projection, including the empty observation, without a live overlay.
      const history = yield* store.runnerContext(created.id, 0)
      const original = JSON.stringify(history)
      const assistant = history.find((message) => message.type === "assistant")
      if (assistant?.type !== "assistant") throw new Error("Missing durable assistant")
      const reasoning = assistant.content.find((part) => part.type === "reasoning")
      if (!fixture.disabled) {
        expect(reasoning?.text).toBe("")
        expect(reasoning?.providerMetadata).toEqual({
          openaiCompatible: { emptyReasoning: { provider: source.provider, model: source.id, thinking: true } },
        })
        expect(reasoning?.time?.completed).toBeDefined()
      }
      if (fixture.disabled) expect(reasoning).toBeUndefined()
      const result = yield* LLMClient.prepare<OpenAIChatBody>(
        LLM.request({ model, tools, messages: toLLMMessages(history, model) }),
      ).pipe(Effect.exit)
      expect(Exit.isSuccess(result)).toBe(fixture.allowed === true)
      expect(JSON.stringify(history)).toBe(original)
      if (Exit.isFailure(result)) {
        expect(String(result.cause)).toContain("reasoning_content")
        return
      }
      expect(result.value.body.messages.find((message) => message.role === "assistant")).toMatchObject({
        reasoning_content: "",
        tool_calls: [{ id: "call-1" }],
      })
      expect(result.value.body.messages.find((message) => message.role === "tool")).toMatchObject({
        tool_call_id: "call-1",
        content: "retained result",
      })
      expect(JSON.stringify(result.value.body)).not.toContain("emptyReasoning")
    }),
  )
}
