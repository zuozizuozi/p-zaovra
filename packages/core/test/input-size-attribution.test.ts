import { expect } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { LLMClient, LLMEvent, Model, type LLMRequest } from "@zaovra-ai/llm"
import { route } from "@zaovra-ai/llm/protocols/openai-chat"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { LayerNodePlatform } from "../src/effect/app-node-platform"
import { BuiltInTools } from "../src/tool/builtins"
import { SessionV2 } from "../src/session"
import { SessionRunner } from "../src/session/runner/index"
import { SessionRunnerModel } from "../src/session/runner/model"
import { SessionExecution } from "../src/session/execution"
import { node } from "../src/session/runner/llm"
import { SessionCache } from "../src/session/cache"
import { ToolProfile } from "../src/session/tool-profile"
import { ToolRegistry } from "../src/tool/registry"
import { PluginV2 } from "../src/plugin"
import { Snapshot } from "../src/snapshot"
import { Location } from "../src/location"
import { Config } from "../src/config"
import { ConfigExperimental } from "../src/config/experimental"
import { tempLocationLayer } from "./fixture/location"
import { testEffect } from "./lib/effect"

const requests: LLMRequest[] = []
const model = Model.make({ id: "deepseek-v4.1-flash-1017", provider: "offline", route })
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([node, BuiltInTools.node, SessionV2.node, ToolRegistry.node, Location.node]), [
    [Location.node, tempLocationLayer],
    [SessionExecution.node, SessionExecution.noopLayer],
    [
      LayerNodePlatform.llmClient,
      Layer.mock(LLMClient.Service, {
        stream: (request: LLMRequest) => {
          requests.push(request)
          return Stream.fromIterable([
            LLMEvent.stepStart({ index: 0 }),
            LLMEvent.textStart({ id: "done" }),
            LLMEvent.textDelta({ id: "done", text: "Local fixture only." }),
            LLMEvent.textEnd({ id: "done" }),
            LLMEvent.stepFinish({ index: 0, reason: "stop" }),
            LLMEvent.finish({ reason: "stop" }),
          ])
        },
      }),
    ],
    [SessionRunnerModel.node, SessionRunnerModel.layerWith(() => Effect.succeed(model))],
    [PluginV2.node, Layer.mock(PluginV2.Service, { wait: () => Effect.void })],
    [Snapshot.node, Snapshot.noopLayer],
    [
      Config.node,
      Layer.succeed(
        Config.Service,
        Config.Service.of({
          entries: () =>
            Effect.succeed([
              new Config.Document({
                type: "document",
                info: new Config.Info({
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
  ]),
)

it.live("660 attribute a real runner initial request and compare existing compact advertisements offline", () =>
  Effect.gen(function* () {
    requests.length = 0
    const sessions = yield* SessionV2.Service
    const runner = yield* SessionRunner.Service
    const location = yield* Location.Service
    const session = yield* sessions.create({ location: { directory: location.directory } })
    yield* sessions.prompt({
      sessionID: session.id,
      prompt: { text: "Inspect the local fixture requirements." },
      resume: false,
    })
    yield* runner.run({ sessionID: session.id, force: false })
    expect(requests).toHaveLength(1)
    const request = requests[0]!
    expect(request.tools.length).toBeGreaterThan(10)
    const sizes = SessionCache.inputSizes(request)
    const compact = ToolProfile.select(request.tools, { model: "gpt-fixture", history: [] })
    const fullBytes = sizes.find((entry) => entry.category === "tools")!.bytes
    expect(Buffer.byteLength(JSON.stringify(compact))).toBeLessThan(fullBytes)
    expect(compact.some((tool) => tool.name === "tool_search")).toBe(true)
    expect(compact.some((tool) => tool.name === "bash_job")).toBe(true)
    console.log(
      JSON.stringify({
        measurement: "660-local-canonical-request",
        scope: "one synthetic-provider current-main runner request, not R4 wire body or tokenizer",
        model_API: 0,
        sizes,
        full_tools: request.tools.length,
        compact_tools: compact.length,
        full_tool_bytes: fullBytes,
        existing_compact_tool_bytes: Buffer.byteLength(JSON.stringify(compact)),
        advertisement_changed_in_product: false,
      }),
    )
  }),
)
