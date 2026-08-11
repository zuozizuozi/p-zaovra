import path from "path"
import { describe, expect } from "bun:test"
import { Config } from "@zaovra-ai/core/config"
import { ConfigMCP } from "@zaovra-ai/core/config/mcp"
import { AppNodeBuilder } from "@zaovra-ai/core/effect/app-node-builder"
import { LayerNode } from "@zaovra-ai/core/effect/layer-node"
import { Location } from "@zaovra-ai/core/location"
import { Integration } from "@zaovra-ai/core/integration"
import { MCP } from "@zaovra-ai/core/mcp"
import { PermissionV2 } from "@zaovra-ai/core/permission"
import { ProjectV2 } from "@zaovra-ai/core/project"
import { AbsolutePath } from "@zaovra-ai/core/schema"
import { ToolOutputStore } from "@zaovra-ai/core/tool-output-store"
import { ApplicationTools } from "@zaovra-ai/core/tool/application-tools"
import { ToolRegistry } from "@zaovra-ai/core/tool/registry"
import { Effect, Layer } from "effect"
import { executeTool, toolDefinitions, toolIdentity } from "./lib/tool"
import { testEffect } from "./lib/effect"
import { SessionV2 } from "@zaovra-ai/core/session"
import { SystemContext } from "@zaovra-ai/core/system-context"
import { SystemContextRegistry } from "@zaovra-ai/core/system-context/registry"

const directory = AbsolutePath.make(path.resolve(import.meta.dirname, "fixture"))
const permissions: PermissionV2.AssertInput[] = []
const config = Layer.succeed(
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
                }),
                remote: new ConfigMCP.Remote({
                  type: "remote",
                  url: "https://mcp.example.test",
                  disabled: true,
                }),
              },
            }),
          }),
        }),
      ]),
  }),
)
const location = Layer.succeed(
  Location.Service,
  Location.Service.of({ directory, project: { id: ProjectV2.ID.global, directory } }),
)
const permission = Layer.mock(PermissionV2.Service, {
  assert: (input) => Effect.sync(() => permissions.push(input)),
})
const layer = AppNodeBuilder.build(
  LayerNode.group([ApplicationTools.node, Integration.node, SystemContextRegistry.node, ToolRegistry.node, MCP.node]),
  [
    [Config.node, config],
    [Location.node, location],
    [PermissionV2.node, permission],
    [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
  ],
)
const it = testEffect(layer)
const sessionID = SessionV2.ID.make("ses_mcp")

describe("MCP canonical tools", () => {
  it.live("registers Location-scoped tools and executes through the canonical registry", () =>
    Effect.gen(function* () {
      permissions.length = 0
      const mcp = yield* MCP.Service
      const integrations = yield* Integration.Service
      const registry = yield* ToolRegistry.Service
      const contexts = yield* SystemContextRegistry.Service
      expect(yield* mcp.status()).toEqual({
        fixture: { status: "connected", tools: 1 },
        remote: { status: "disabled" },
      })
      expect(yield* mcp.instructions()).toEqual([
        {
          name: "fixture",
          instructions: "Use project facts as the durable source of truth.",
          tools: ["mcp_fixture_echo"],
        },
      ])
      expect(yield* integrations.get(Integration.ID.make("mcp:remote"))).toMatchObject({
        id: "mcp:remote",
        name: "MCP: remote",
        methods: [{ id: "oauth", type: "oauth", label: "OAuth" }],
      })
      expect(yield* mcp.resources()).toEqual({
        "fixture:memory://project/facts": {
          name: "project facts",
          uri: "memory://project/facts",
          description: undefined,
          mimeType: "text/plain",
          client: "fixture",
        },
      })
      expect((yield* SystemContext.initialize(yield* contexts.load())).baseline).toContain(
        "Use project facts as the durable source of truth.",
      )
      expect((yield* toolDefinitions(registry)).map((definition) => definition.name)).toContain("mcp_fixture_echo")
      expect(
        (yield* toolDefinitions(registry)).find((definition) => definition.name === "mcp_fixture_echo"),
      ).toMatchObject({
        inputSchema: {
          properties: { text: { type: "string", minLength: 1 } },
          required: ["text"],
          additionalProperties: false,
        },
      })

      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-mcp", name: "mcp_fixture_echo", input: { text: "stable" } },
        }),
      ).toEqual({ type: "text", value: "echo:stable" })
      expect(permissions).toMatchObject([{ action: "mcp_fixture_echo", resources: ["*"] }])
    }),
  )

  it.live("exposes resources and prompts through canonical catalog tools", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const resource = yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "call-resource",
          name: "read_mcp_resource",
          input: { server: "fixture", uri: "memory://project/facts" },
        },
      })
      expect(resource).toMatchObject({ type: "text" })
      if (resource.type !== "text") return
      expect(resource.value).toContain("ZAOVRA uses WorkGraph")

      const prompt = yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "call-prompt",
          name: "get_mcp_prompt",
          input: { server: "fixture", name: "review", arguments: { target: "runtime" } },
        },
      })
      expect(prompt).toMatchObject({ type: "text" })
      if (prompt.type !== "text") return
      expect(prompt.value).toContain("Review runtime")
    }),
  )
})
