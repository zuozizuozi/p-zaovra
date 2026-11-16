import { expect, test } from "bun:test"
import path from "node:path"
import { Effect, Layer, ManagedRuntime, Stream } from "effect"
import { LLMClient, LLMEvent, Model, type LLMRequest } from "@zaovra-ai/llm"
import { OpenAIChat } from "@zaovra-ai/llm/protocols/openai-chat"
import { Config } from "../src/config"
import { ConfigExperimental } from "../src/config/experimental"
import { Catalog } from "../src/catalog"
import { Database } from "../src/database/database"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { LayerNodePlatform } from "../src/effect/app-node-platform"
import { EventV2 } from "../src/event"
import { Global } from "../src/global"
import { Location } from "../src/location"
import { ModelV2 } from "../src/model"
import { ModelMemoryProfile } from "../src/model-memory-profile"
import { ProviderV2 } from "../src/provider"
import { MemoryTool } from "../src/tool/memory"
import { PluginV2 } from "../src/plugin"
import { AbsolutePath } from "../src/schema"
import { SessionV2 } from "../src/session"
import { SessionExecution } from "../src/session/execution"
import { SessionRunner } from "../src/session/runner"
import { node } from "../src/session/runner/llm"
import { SessionRunnerModel } from "../src/session/runner/model"
import { Snapshot } from "../src/snapshot"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"

function runtime(
  directory: string,
  state: { enabled: boolean; taskSearch: boolean },
  requests: LLMRequest[],
  evaluated: boolean,
) {
  return ManagedRuntime.make(
    AppNodeBuilder.build(
      LayerNode.group([
        Catalog.node,
        MemoryTool.node,
        Location.node,
        SessionV2.node,
        Database.node,
        EventV2.node,
        ...(requests ? [node] : []),
      ]),
      [
        [
          ModelMemoryProfile.node,
          Layer.succeed(
            ModelMemoryProfile.Service,
            ModelMemoryProfile.Service.of({
              memoryNote: (model, variant) =>
                evaluated && model.id === "offline" && model.providerID === "offline" && variant === undefined
                  ? true
                  : undefined,
            }),
          ),
        ],
        [Location.node, Layer.succeed(Location.Service, location({ directory: AbsolutePath.make(directory) }))],
        [Database.node, Database.layerFromPath(path.join(directory, "task-memory.db"))],
        [
          Global.node,
          Global.layerWith({
            data: path.join(directory, "data"),
            config: path.join(directory, "config"),
            state: path.join(directory, "state"),
          }),
        ],
        [SessionExecution.node, SessionExecution.noopLayer],
        [
          Config.node,
          Layer.succeed(
            Config.Service,
            Config.Service.of({
              entries: () =>
                Effect.sync(() => [
                  new Config.Document({
                    type: "document",
                    info: new Config.Info({
                      memory: { ...state },
                      experimental: new ConfigExperimental.Experimental({
                        verification: false,
                        delivery_contract: false,
                        quality_progress: { facts: false, stagnation_log: false },
                      }),
                    }),
                  }),
                ]),
            }),
          ),
        ],
        [PluginV2.node, Layer.mock(PluginV2.Service, { wait: () => Effect.void })],
        [Snapshot.node, Snapshot.noopLayer],
        [
          SessionRunnerModel.node,
          SessionRunnerModel.layerWith(() =>
            Effect.succeed(Model.make({ id: "offline", provider: "offline", route: OpenAIChat.route })),
          ),
        ],
        [
          LayerNodePlatform.llmClient,
          Layer.succeed(
            LLMClient.Service,
            LLMClient.Service.of({
              prepare: () => Effect.die("unused: scripted provider events"),
              generate: () => Effect.die("unused"),
              stream: (request) => {
                requests?.push(request)
                return Stream.fromIterable<LLMEvent>([
                  LLMEvent.stepStart({ index: 0 }),
                  LLMEvent.textStart({ id: "done" }),
                  LLMEvent.textDelta({ id: "done", text: "Fixture response complete." }),
                  LLMEvent.textEnd({ id: "done" }),
                  LLMEvent.stepFinish({ index: 0, reason: "stop" }),
                  LLMEvent.finish({ reason: "stop" }),
                ])
              },
            }),
          ),
        ],
      ],
    ),
  )
}

for (const evaluated of [false, true]) {
  test(`real runner memory advertisement requires a host profile: ${evaluated}`, async () => {
    await using temp = await tmpdir()
    const requests: LLMRequest[] = []
    const state = { enabled: true, taskSearch: false }
    const app = runtime(temp.path, state, requests, evaluated)
    await app
      .runPromise(
        Effect.gen(function* () {
          const sessions = yield* SessionV2.Service
          const catalog = yield* Catalog.Service
          const here = yield* Location.Service
          const runner = yield* SessionRunner.Service
          const model = { id: ModelV2.ID.make("offline"), providerID: ProviderV2.ID.make("offline") }
          yield* catalog.transform((draft) => {
            draft.provider.update(model.providerID, (provider) => {
              provider.integrationID = undefined
            })
            draft.model.update(model.providerID, model.id, (entry) => {
              entry.enabled = true
              entry.capabilities.tools = true
              entry.capabilities.memoryNote = true
            })
          })
          const session = yield* sessions.create({ model, location: { directory: here.directory } })
          yield* sessions.prompt({
            sessionID: session.id,
            resume: false,
            prompt: { text: "Remember my preference for offline tests." },
          })
          yield* runner.run({ sessionID: session.id, force: true })
          expect(requests).toHaveLength(1)
          expect(requests[0].tools.some((tool) => tool.name === "memory_note")).toBe(evaluated)
          state.enabled = false
          yield* sessions.prompt({ sessionID: session.id, resume: false, prompt: { text: "Continue checking." } })
          yield* runner.run({ sessionID: session.id, force: true })
          expect(requests).toHaveLength(2)
          expect(requests[1].tools.some((tool) => tool.name === "memory_note")).toBe(false)
        }).pipe(Effect.scoped),
      )
      .finally(() => app.dispose())
  })
}
