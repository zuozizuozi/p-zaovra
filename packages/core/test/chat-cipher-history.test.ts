import { expect } from "bun:test"
import { LLM, Model } from "@zaovra-ai/llm"
import { LLMClient } from "@zaovra-ai/llm/route"
import { OpenAICompatible } from "@zaovra-ai/llm/providers"
import type { OpenAIChatBody } from "@zaovra-ai/llm/protocols/openai-chat"
import { DateTime, Effect, Layer, Stream } from "effect"
import { adjust } from "effect/testing/TestClock"
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
import { dynamicResponse, fixedResponse } from "../../llm/test/lib/http"
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
const model = OpenAICompatible.configure({ baseURL: "https://synthetic.invalid/v1", apiKey: "synthetic" }).model(
  "fixture",
)
const cipher = "opaque-tail+/=\r\n签名"
for (const fixture of [
  {
    name: "ciphertext before text",
    deltas: [{ reasoning_content: "summary", encrypted_content: cipher }, { content: "answer" }],
    encrypted: cipher,
  },
  {
    name: "tail only",
    deltas: [{ reasoning_content: "summary" }, { content: "answer" }, { encrypted_content: cipher }],
    encrypted: cipher,
  },
  {
    name: "split around text",
    deltas: [
      { reasoning_content: "summary", encrypted_content: "opaque-" },
      { content: "answer" },
      { encrypted_content: "tail+/=\r\n签名" },
    ],
    encrypted: cipher,
  },
  {
    name: "split around tool",
    deltas: [
      { reasoning_content: "summary", encrypted_content: "opaque-" },
      { tool_calls: [{ index: 0, id: "call-1", function: { name: "read", arguments: "{}" } }] },
      { encrypted_content: "tail+/=\r\n签名" },
    ],
    encrypted: cipher,
  },
  { name: "no ciphertext", deltas: [{ reasoning_content: "summary" }, { content: "answer" }], encrypted: undefined },
]) {
  it.effect(`180 Chat stream to durable history to wire: ${fixture.name}`, () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const store = yield* SessionStore.Service
      const created = yield* session.create({
        location: Location.Ref.make({ directory: AbsolutePath.make("/synthetic") }),
      })
      const publisher = createLLMEventPublisher(events, {
        sessionID: created.id,
        agent: "build",
        model: { id: ModelV2.ID.make(String(model.id)), providerID: ProviderV2.ID.make(String(model.provider)) },
        inputSequence: 0,
        contextEpoch: 0,
      })
      let firstEnd: DateTime.Utc | undefined
      let ends = 0
      yield* LLMClient.stream(LLM.request({ model, prompt: "synthetic" })).pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            if (event.type === "reasoning-end") {
              firstEnd ??= yield* DateTime.now
              ends++
            }
            yield* publisher.publish(event)
            if (event.type === "reasoning-end") yield* adjust("1 second")
          }),
        ),
        Effect.provide(
          fixedResponse(
            sseEvents(...fixture.deltas.map((delta) => ({ choices: [{ delta }] })), {
              choices: [{ delta: {}, finish_reason: fixture.name.includes("tool") ? "tool_calls" : "stop" }],
            }),
          ),
        ),
      )
      yield* events.publish(SessionEvent.Step.Ended, {
        sessionID: created.id,
        assistantMessageID: yield* publisher.startAssistant(),
        timestamp: yield* DateTime.now,
        finish: "stop",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      })
      // runnerContext reads the durable projection without the live overlay.
      const history = yield* store.runnerContext(created.id, 0)
      const prepared = yield* LLMClient.prepare<OpenAIChatBody>(
        LLM.request({ model: Model.make(Model.input(model)), messages: toLLMMessages(history, model) }),
      )
      expect(prepared.body.messages.find((message) => message.role === "assistant")?.encrypted_content).toBe(
        fixture.encrypted,
      )
      const assistant = history.find((message) => message.type === "assistant")
      expect(assistant?.type).toBe("assistant")
      if (assistant?.type !== "assistant") throw new Error("Missing assistant projection")
      expect(assistant.content.filter((part) => part.type === "reasoning")).toHaveLength(1)
      expect(assistant.content.filter((part) => part.type === "reasoning").map((part) => part.text)).toEqual([
        "summary",
      ])
      const reasoning = assistant.content.find((part) => part.type === "reasoning")!
      expect(DateTime.toEpochMillis(reasoning.time!.completed!)).toBe(DateTime.toEpochMillis(firstEnd!))
      if (fixture.name === "ciphertext before text") expect(ends).toBe(1)
      if (fixture.encrypted === undefined) return
      let attempts = 0
      const response = yield* LLMClient.generate(LLM.request({ model, messages: toLLMMessages(history, model) })).pipe(
        Effect.provide(
          dynamicResponse(({ text, respond }) =>
            Effect.sync(() => {
              const body = JSON.parse(text)
              attempts++
              const assistant = body.messages.find((message: { role: string }) => message.role === "assistant")
              if (attempts === 1) {
                expect(assistant.encrypted_content).toBe(fixture.encrypted)
                return respond(
                  JSON.stringify({ error: { code: "invalid_encrypted_content", message: "local rejection" } }),
                  { status: 400 },
                )
              }
              expect(assistant).not.toHaveProperty("encrypted_content")
              expect(assistant.reasoning_content).toBe("summary")
              return respond(
                sseEvents(
                  { choices: [{ delta: { content: "recovered" } }] },
                  { choices: [{ delta: {}, finish_reason: "stop" }] },
                ),
                { headers: { "content-type": "text/event-stream" } },
              )
            }),
          ),
        ),
      )
      expect(attempts).toBe(2)
      expect(response.message.content).toContainEqual(expect.objectContaining({ type: "text", text: "recovered" }))
      const after = yield* store.runnerContext(created.id, 0)
      expect(
        (yield* LLMClient.prepare<OpenAIChatBody>(LLM.request({ model, messages: toLLMMessages(after, model) }))).body,
      ).toEqual(prepared.body)
    }),
  )
}
