import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer, LayerMap, Schema, Stream } from "effect"
import { LLM, LLMClient, Model } from "@zaovra-ai/llm"
import { route } from "@zaovra-ai/llm/protocols/openai-chat"
import { dynamicResponse } from "../../llm/test/lib/http"
import { sseEvents } from "../../llm/test/lib/sse"
import { deltaChunk } from "../../llm/test/lib/openai-chunks"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { BuiltInTools } from "../src/tool/builtins"
import { TaskTool } from "../src/tool/task"
import { ApplicationTools } from "../src/tool/application-tools"
import { Tool } from "../src/tool/tool"
import { MCP } from "../src/mcp"
import { SessionV2 } from "../src/session"
import { SessionMessage } from "../src/session/message"
import { LocationServiceMap } from "../src/location-service-map"
import type { LocationError, LocationServices } from "../src/location-services"
import { ToolRegistry } from "../src/tool/registry"
import { ToolProfile } from "../src/session/tool-profile"
import { PermissionV2 } from "../src/permission"
import { Config } from "../src/config"
import { ConfigMCP } from "../src/config/mcp"
import { Location } from "../src/location"
import { tempLocationLayer } from "./fixture/location"
import { testEffect } from "./lib/effect"
import fixtures from "./fixtures/tool-profile-advantages.json"
const suite = (configured: boolean) =>
  testEffect(
    AppNodeBuilder.build(
      LayerNode.group([BuiltInTools.node, TaskTool.node, MCP.node, ToolRegistry.node, ApplicationTools.node]),
      [
        [Location.node, tempLocationLayer],
        [PermissionV2.node, Layer.mock(PermissionV2.Service, { assert: () => Effect.void })],
        [
          Config.node,
          Layer.succeed(
            Config.Service,
            Config.Service.of({
              entries: () =>
                Effect.succeed(
                  configured
                    ? [
                        new Config.Document({
                          type: "document",
                          info: new Config.Info({
                            mcp: new ConfigMCP.Info({
                              servers: {
                                offline: new ConfigMCP.Remote({
                                  type: "remote",
                                  url: "https://offline.invalid",
                                  disabled: true,
                                }),
                              },
                            }),
                          }),
                        }),
                      ]
                    : [],
                ),
            }),
          ),
        ],
        [
          SessionV2.node,
          Layer.mock(SessionV2.Service, {
            revert: {
              stage: () => Effect.die("unused"),
              clear: () => Effect.die("unused"),
              commit: () => Effect.die("unused"),
            },
          }),
        ],
        [
          LocationServiceMap.node,
          Layer.effect(
            LocationServiceMap.Service,
            LayerMap.make(
              (_ref: Location.Ref): Layer.Layer<LocationServices, LocationError> =>
                Layer.unwrap(Effect.die("No child execution in advertisement fixtures")),
            ),
          ),
        ],
      ],
    ),
  )
const model = Model.make({ id: "gpt-6-luna", provider: "offline", route })
describe("P2 fixed HTTP schema comparison and source-task fidelity", () => {
  for (const configured of [false, true]) {
    const it = suite(configured)
    it.live(
      `${configured ? "configured" : "empty"} preserves a real external application override of shipped task`,
      () =>
        Effect.gen(function* () {
          const applications = yield* ApplicationTools.Service
          const registry = yield* ToolRegistry.Service
          expect(applications.entries().get("task")?.origin).toBe("shipped")
          yield* applications.register({
            task: Tool.make({
              description: "External application task override",
              input: Schema.Struct({ external: Schema.String }),
              output: Schema.String,
              execute: (input) => Effect.succeed(input.external),
            }),
          })
          const materialized = yield* registry.materialize()
          expect(materialized.custom).toContain("task")
          expect(
            ToolProfile.select(materialized.definitions, {
              model: model.id,
              history: [],
              custom: materialized.custom,
            }).find((tool) => tool.name === "task")?.inputSchema,
          ).toHaveProperty("properties.external")
        }),
    )
    for (const fixture of fixtures)
      it.live(
        `${configured ? "configured-disconnected" : "no-MCP"} ${fixture.task} retains real history with shipped Task/MCP graph`,
        () =>
          Effect.gen(function* () {
            expect(new Bun.CryptoHasher("sha256").update(fixture.instruction).digest("hex")).toBe(fixture.sha256)
            const registry = yield* ToolRegistry.Service
            const materialized = yield* registry.materialize()
            const all = materialized.definitions
            const history = [
              SessionMessage.User.make({
                id: SessionMessage.ID.make("msg_wire_user"),
                type: "user",
                text: fixture.instruction,
                time: { created: DateTime.makeUnsafe(0) },
              }),
            ]
            expect(history[0]!.text).toBe(fixture.instruction)
            expect(materialized.custom).not.toContain("task")
            expect(names(all)).toEqual(
              expect.arrayContaining(["task", "task_status", "task_list", "task_cancel", "task_resume"]),
            )
            expect(names(all).includes("list_mcp_resources")).toBe(configured)
            const baseline = all.filter((tool) => tool.name !== "tool_search")
            const selected =
              process.env.ZAOVRA_PROFILE_BASELINE === "true"
                ? baseline
                : ToolProfile.select(all, { model: model.id, history, custom: materialized.custom })
            const bodies: Record<string, unknown>[] = []
            for (const tools of [baseline, selected])
              yield* LLMClient.stream(LLM.request({ model, prompt: fixture.instruction, tools })).pipe(
                Stream.runCollect,
                Effect.provide(
                  dynamicResponse((input) => {
                    bodies.push(JSON.parse(input.text))
                    return Effect.succeed(
                      input.respond(sseEvents(deltaChunk({ content: "fixed local reply" }), deltaChunk({}, "stop")), {
                        headers: { "content-type": "text/event-stream" },
                      }),
                    )
                  }),
                ),
              )
            expect(bodies).toHaveLength(2)
            expect(bodies[0]!.messages).toEqual(bodies[1]!.messages)
            expect(JSON.stringify(bodies[1]!.messages)).toContain(JSON.stringify(fixture.instruction).slice(1, -1))
            const before = Buffer.byteLength(JSON.stringify(bodies[0]!.tools))
            const after = Buffer.byteLength(JSON.stringify(bodies[1]!.tools))
            expect(after).toBeLessThan(before)
            expect(names(selected)).toContain("apply_patch")
            expect(names(selected)).toContain("tool_search")
            expect(names(selected)).not.toContain("write")
            expect(names(selected)).not.toContain("task")
            expect(names(selected)).not.toContain("task_status")
            expect(names(selected)).not.toContain("list_mcp_resources")
            if (process.env.ZAOVRA_PROFILE_REPORT)
              yield* Effect.promise(() =>
                Bun.write(
                  process.env.ZAOVRA_PROFILE_REPORT! +
                    "/" +
                    (configured ? "configured-" : "empty-") +
                    fixture.task +
                    ".json",
                  JSON.stringify(
                    {
                      task: fixture.task,
                      instruction_sha256: fixture.sha256,
                      history_instruction_sha256: new Bun.CryptoHasher("sha256").update(history[0]!.text).digest("hex"),
                      actual_task_node: true,
                      actual_mcp_node: true,
                      configured_mcp: configured,
                      protocol: "OpenAI-compatible Chat fixed HTTP, Auth.none, no network",
                      before_tools: baseline.length,
                      after_tools: selected.length,
                      before_schema_bytes: before,
                      after_schema_bytes: after,
                      messages_equal: true,
                      unit: "UTF-8 JSON wire tools bytes; no tokenizer, not actual Luna token/cost or solution quality",
                    },
                    null,
                    2,
                  ),
                ),
              )
          }),
      )
  }
})
function names(
  tools: readonly {
    name: string
  }[],
) {
  return tools.map((tool) => tool.name)
}
