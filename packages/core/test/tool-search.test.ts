import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { AgentV2 } from "../src/agent"
import { ApplicationTools } from "../src/tool/application-tools"
import { ToolProfile } from "../src/session/tool-profile"
import { Evidence } from "../src/evidence"
import { PermissionV2 } from "../src/permission"
import { SessionV2 } from "../src/session"
import { SessionMessage } from "../src/session/message"
import { ToolOutputStore } from "../src/tool-output-store"
import { Tool } from "../src/tool/tool"
import { ToolRegistry } from "../src/tool/registry"
import { Config } from "../src/config"
import { ToolSearch } from "../src/tool/tool-search"
import { MemoryWritePolicy } from "../src/memory/write-policy"
import { testEffect } from "./lib/effect"
const suite = (modelTools: boolean) =>
  testEffect(
    AppNodeBuilder.build(LayerNode.group([ToolSearch.node, ToolRegistry.node, AgentV2.node, ApplicationTools.node]), [
      [
        MemoryWritePolicy.node,
        Layer.succeed(
          MemoryWritePolicy.Service,
          MemoryWritePolicy.Service.of({ allowed: () => Effect.succeed(false) }),
        ),
      ],
      [
        Config.node,
        Layer.succeed(
          Config.Service,
          Config.Service.of({
            entries: () =>
              Effect.succeed([
                new Config.Document({
                  type: "document",
                  info: new Config.Info({ memory: { enabled: true, modelTools } }),
                }),
              ]),
          }),
        ),
      ],
      [PermissionV2.node, Layer.mock(PermissionV2.Service, { assert: () => Effect.void })],
      [
        ToolOutputStore.node,
        Layer.mock(ToolOutputStore.Service, {
          capture: () => ({
            append: () => Effect.void,
            paths: () => [],
            snapshot: () => ({ output: "", cursor: 0, truncated: false }),
          }),
          bound: (input) => Effect.succeed({ output: input.output, outputPaths: [] }),
        }),
      ],
      [Evidence.node, Layer.mock(Evidence.Service, { retain: () => Effect.succeed([]) })],
    ]),
  )
const it = suite(true)
const indexOnly = suite(false)
const context = {
  sessionID: SessionV2.ID.make("ses_discovery"),
  agent: AgentV2.ID.make("build"),
  assistantMessageID: SessionMessage.ID.make("msg_discovery"),
}
const query = (registry: ToolRegistry.Interface, input: Record<string, unknown>) =>
  registry
    .materialize()
    .pipe(
      Effect.flatMap((tools) =>
        tools.settle({ ...context, call: { type: "tool-call", id: "discover", name: "tool_search", input } }),
      ),
    )
describe("canonical tool discovery", () => {
  indexOnly.effect("keeps memory tools out of index-only discovery while leaving file reads available", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      for (const name of ["memory_check", "read"])
        yield* registry.register({
          [name]: Tool.make({
            description: name,
            input: Schema.Struct({}),
            output: Schema.String,
            execute: () => Effect.die("must not execute"),
          }),
        })
      expect((yield* query(registry, {})).output?.structured).toEqual({
        activated: [],
        available: [{ name: "read", description: "read" }],
      })
      expect((yield* query(registry, { names: ["memory_check"] })).result).toMatchObject({ type: "error" })
    }),
  )
  it.effect("does not list or activate memory_note for an unknown session model", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      yield* registry.register({
        memory_note: Tool.make({
          description: "memory note",
          input: Schema.Struct({}),
          output: Schema.String,
          execute: () => Effect.die("must not execute"),
        }),
      })
      for (const input of [{}, { query: "unmatched-token" }])
        expect((yield* query(registry, input)).output?.structured).toEqual({ activated: [], available: [] })
      expect((yield* query(registry, { names: ["memory_note"] })).result).toMatchObject({ type: "error" })
    }),
  )
  it.effect("lists and activates complete registered capabilities without executing them", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const calls: string[] = []
      for (const name of ["browser", "task", "webfetch"])
        yield* registry.register({
          [name]: Tool.make({
            description: name + " capability",
            input: Schema.Struct({ requiredArgument: Schema.String }),
            output: Schema.String,
            execute: () =>
              Effect.sync(() => {
                calls.push(name)
                return "executed"
              }),
          }),
        })
      expect((yield* query(registry, {})).output?.structured).toEqual({
        activated: [],
        available: ["browser", "task", "webfetch"].map((name) => ({ name, description: name + " capability" })),
      })
      expect((yield* query(registry, { names: ["browser", "task"] })).output?.structured).toMatchObject({
        activated: ["browser", "task"],
      })
      expect((yield* query(registry, { query: "webfetch" })).output?.structured).toMatchObject({
        activated: ["webfetch"],
      })
      expect(calls).toEqual([])
      expect(
        (yield* registry.materialize()).definitions.find((tool) => tool.name === "browser")?.inputSchema,
      ).toHaveProperty("properties.requiredArgument")
    }),
  )
  it.effect("does not reveal or activate a permission-disabled tool", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const agents = yield* AgentV2.Service
      yield* agents.transform((draft) =>
        draft.update(context.agent, (agent) => {
          agent.permissions.push({ action: "browser", resource: "*", effect: "deny" })
        }),
      )
      yield* registry.register({
        browser: Tool.make({
          description: "browser",
          input: Schema.Struct({}),
          output: Schema.String,
          execute: () => Effect.die("must not execute"),
        }),
      })
      expect((yield* query(registry, {})).output?.structured).toEqual({ activated: [], available: [] })
      expect((yield* query(registry, { names: ["browser"] })).result).toMatchObject({
        type: "error",
        value: expect.stringContaining("unavailable"),
      })
    }),
  )
})

it.effect("keeps a real application write override in the GPT advertisement", () =>
  Effect.gen(function* () {
    const registry = yield* ToolRegistry.Service
    const applications = yield* ApplicationTools.Service
    const leaf = Tool.make({
      description: "Explicit application capability",
      input: Schema.Struct({}),
      output: Schema.String,
      execute: () => Effect.succeed("retained"),
    })
    yield* registry.register({ apply_patch: leaf })
    yield* applications.register({ write: leaf })
    const materialization = yield* registry.materialize()
    expect(materialization.custom).toContain("write")
    expect(
      ToolProfile.select(materialization.definitions, {
        model: "gpt-6-luna",
        history: [],
        custom: materialization.custom,
      }).map((tool) => tool.name),
    ).toContain("write")
  }),
)
