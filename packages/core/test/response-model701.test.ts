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

const model = OpenAICompatible.configure({ baseURL: "https://synthetic.invalid/v1", apiKey: "synthetic" }).model(
  "selected-701",
)
for (const actual of ["returned-701", undefined]) {
  it.effect("701 response model persists independently of selection: " + String(actual), () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const store = yield* SessionStore.Service
      const created = yield* sessions.create({
        location: Location.Ref.make({ directory: AbsolutePath.make("/synthetic") }),
      })
      const selected = { id: ModelV2.ID.make(String(model.id)), providerID: ProviderV2.ID.make(String(model.provider)) }
      const publisher = createLLMEventPublisher(events, {
        sessionID: created.id,
        agent: "build",
        model: selected,
        inputSequence: 0,
        contextEpoch: 0,
      })
      yield* LLMClient.stream(LLM.request({ model, prompt: "synthetic" })).pipe(
        Stream.runForEach((event) => publisher.publish(event)),
        Effect.provide(
          fixedResponse(
            sseEvents(
              { ...(actual ? { model: actual } : {}), choices: [{ delta: { content: "answer" } }] },
              {
                choices: [{ delta: {}, finish_reason: "stop" }],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
              },
            ),
          ),
        ),
      )
      const settlement = publisher.stepSettlement()
      expect(settlement?.responseModel).toBe(actual)
      if (!settlement) throw new Error("Missing settlement")
      yield* events.publish(SessionEvent.Step.Ended, {
        sessionID: created.id,
        assistantMessageID: yield* publisher.startAssistant(),
        timestamp: yield* DateTime.now,
        finish: settlement.finish,
        cost: 0,
        tokens: settlement.tokens,
        responseModel: settlement.responseModel,
      })
      const history = yield* store.runnerContext(created.id, 0)
      const assistant = history.find((m) => m.type === "assistant")
      expect(assistant?.metadata?.responseModel).toBe(actual)
      if (assistant?.type !== "assistant") throw new Error("Missing assistant")
      expect(String(assistant.model.id)).toBe("selected-701")
    }),
  )
}
