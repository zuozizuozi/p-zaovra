import path from "path"
import { expect } from "bun:test"
import { Config } from "@zaovra-ai/core/config"
import { ConfigMCP } from "@zaovra-ai/core/config/mcp"
import { AppNodeBuilder } from "@zaovra-ai/core/effect/app-node-builder"
import { LayerNode } from "@zaovra-ai/core/effect/layer-node"
import { MCP } from "@zaovra-ai/core/mcp"
import { PermissionV2 } from "@zaovra-ai/core/permission"
import { ToolRegistry } from "@zaovra-ai/core/tool/registry"
import { ApplicationTools } from "@zaovra-ai/core/tool/application-tools"
import { ToolOutputStore } from "@zaovra-ai/core/tool-output-store"
import { Location } from "@zaovra-ai/core/location"
import { ProjectV2 } from "@zaovra-ai/core/project"
import { AbsolutePath } from "@zaovra-ai/core/schema"
import { SessionV2 } from "@zaovra-ai/core/session"
import { Effect, Layer } from "effect"
import { testEffect } from "./lib/effect"
import { executeTool, toolIdentity } from "./lib/tool"

const directory = AbsolutePath.make(path.resolve(import.meta.dirname, "fixture"))
for (const dialect of [
  undefined,
  "https://json-schema.org/draft/2020-12/schema",
  "http://json-schema.org/draft-07/schema#",
  "https://invalid.test/schema",
]) {
  const old = dialect?.includes("draft-07")
  const schema = {
    ...(dialect ? { $schema: dialect } : {}),
    type: "object",
    properties: {
      tuple: old
        ? { type: "array", items: [{ type: "string" }], additionalItems: false }
        : { type: "array", prefixItems: [{ type: "string" }], items: false },
      a: { type: "string" },
      b: { type: "string" },
      c: { type: "string" },
    },
    ...(old
      ? { dependencies: { a: ["b"] }, additionalProperties: false }
      : {
          dependentRequired: { a: ["b"] },
          dependentSchemas: { b: { required: ["c"] } },
          unevaluatedProperties: false,
        }),
  }
  const approvals: PermissionV2.AssertInput[] = []
  const it = testEffect(
    AppNodeBuilder.build(LayerNode.group([ApplicationTools.node, ToolRegistry.node, MCP.node]), [
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
                    mcp: new ConfigMCP.Info({
                      servers: {
                        fixture: new ConfigMCP.Local({
                          type: "local",
                          command: [process.execPath, path.join(directory, "mcp-canonical-stdio.ts")],
                          environment: { MCP_TEST_SCHEMA: JSON.stringify(schema), MCP_TEST_APPROVAL: "1" },
                        }),
                      },
                    }),
                  }),
                }),
              ]),
          }),
        ),
      ],
      [
        Location.node,
        Layer.succeed(
          Location.Service,
          Location.Service.of({ directory, project: { id: ProjectV2.ID.global, directory } }),
        ),
      ],
      [
        PermissionV2.node,
        Layer.mock(PermissionV2.Service, {
          assert: (input) =>
            Effect.sync(() => {
              approvals.push(input)
            }),
        }),
      ],
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
    ]),
  )
  it.live(
    `V2 validates MCP dialect ${dialect ?? "default 2020-12"} before approval`,
    () =>
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        const call = (input: Record<string, unknown>) =>
          executeTool(registry, {
            sessionID: SessionV2.ID.make("ses_dialect"),
            ...toolIdentity,
            call: { type: "tool-call", id: "dialect", name: "mcp_fixture_echo", input },
          })
        for (const input of [
          { tuple: [42] },
          { tuple: ["ok", "extra"] },
          { a: "x" },
          { extra: true },
          ...(!old ? [{ b: "x" }] : []),
        ]) {
          expect((yield* call(input)).type).toBe("error")
          expect(approvals).toHaveLength(0)
        }
        const input = { tuple: ["ok"], a: "x", b: "y", c: "z" }
        const output = yield* call(input)
        if (dialect === "https://invalid.test/schema") {
          expect(output.type).toBe("error")
          expect(approvals).toHaveLength(0)
          return
        }
        expect(output).toEqual({ type: "text", value: JSON.stringify({ arguments: input, calls: 1 }) })
        expect(approvals).toHaveLength(1)
      }),
    30000,
  )
}
