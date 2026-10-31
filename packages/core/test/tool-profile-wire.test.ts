import { describe, expect } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { LLM, LLMClient, Model } from "@zaovra-ai/llm"
import { route } from "@zaovra-ai/llm/protocols/openai-chat"
import { dynamicResponse } from "../../llm/test/lib/http"
import { sseEvents } from "../../llm/test/lib/sse"
import { deltaChunk } from "../../llm/test/lib/openai-chunks"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { BuiltInTools } from "../src/tool/builtins"
import { ToolRegistry } from "../src/tool/registry"
import { ToolProfile } from "../src/session/tool-profile"
import { PermissionV2 } from "../src/permission"
import { Config } from "../src/config"
import { Location } from "../src/location"
import { tempLocationLayer } from "./fixture/location"
import { testEffect } from "./lib/effect"
import fixtures from "./fixtures/tool-profile-advantages.json"
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([BuiltInTools.node, ToolRegistry.node]), [
    [Location.node, tempLocationLayer],
    [PermissionV2.node, Layer.mock(PermissionV2.Service, { assert: () => Effect.void })],
    [Config.node, Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed([]) }))],
  ]),
)
const model = Model.make({ id: "gpt-6-luna", provider: "offline", route })
describe("P2 fixed HTTP schema comparison and source-task fidelity", () => {
  for (const fixture of fixtures)
    it.live(fixture.task + " retains all instruction bytes while only tool advertisements change", () =>
      Effect.gen(function* () {
        expect(new Bun.CryptoHasher("sha256").update(fixture.instruction).digest("hex")).toBe(fixture.sha256)
        const registry = yield* ToolRegistry.Service
        const all = (yield* registry.materialize()).definitions
        const baseline = all.filter((tool) => tool.name !== "tool_search")
        const selected =
          process.env.ZAOVRA_PROFILE_BASELINE === "true"
            ? baseline
            : ToolProfile.select(all, { model: model.id, history: [] })
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
        if (process.env.ZAOVRA_PROFILE_REPORT)
          yield* Effect.promise(() =>
            Bun.write(
              process.env.ZAOVRA_PROFILE_REPORT! + "/" + fixture.task + ".json",
              JSON.stringify(
                {
                  task: fixture.task,
                  instruction_sha256: fixture.sha256,
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
})
function names(
  tools: readonly {
    name: string
  }[],
) {
  return tools.map((tool) => tool.name)
}
