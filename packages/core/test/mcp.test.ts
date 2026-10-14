import path from "path"
import { describe, expect } from "bun:test"
import { Config } from "@zaovra-ai/core/config"
import { Evidence } from "@zaovra-ai/core/evidence"
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
import { executeTool, settleTool, toolDefinitions, toolIdentity } from "./lib/tool"
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
                  environment: { MCP_TEST_STDERR: "1" },
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
  LayerNode.group([
    ApplicationTools.node,
    Integration.node,
    SystemContextRegistry.node,
    ToolRegistry.node,
    MCP.node,
    Evidence.node,
  ]),
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
  it.live("preserves the exact legacy name and permission action when no tools collide", () =>
    Effect.gen(function* () {
      const mcp = yield* MCP.Service
      const registry = yield* ToolRegistry.Service
      expect((yield* mcp.instructions())[0].tools).toEqual(["mcp_fixture_echo"])
      permissions.length = 0
      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "legacy-name", name: "mcp_fixture_echo", input: { text: "legacy" } },
        }),
      ).toEqual({ type: "text", value: "echo:legacy" })
      expect(permissions[0].action).toBe("mcp_fixture_echo")
    }),
  )
  for (const pair of [
    [
      ["a_b", "c"],
      ["a", "b_c"],
    ],
    [
      ["a.b", "echo"],
      ["a_b", "echo"],
    ],
    [
      ["long".repeat(20), "echo".repeat(20)],
      ["long".repeat(20), "echo".repeat(20) + "2"],
    ],
  ]) {
    // Different long server names keep both tools on independently reconnectable services.
    const entries = pair[0][0] === pair[1][0] ? [pair[0], [pair[1][0] + "2", pair[1][1]]] : pair
    const collisionIt = testEffect(
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
                        servers: Object.fromEntries(
                          entries.map(([server, tool]) => [
                            server,
                            new ConfigMCP.Local({
                              type: "local",
                              disabled: true,
                              command: [process.execPath, path.join(directory, "mcp-canonical-stdio.ts")],
                              environment: { MCP_TEST_SERVER: server, MCP_TEST_TOOL: tool },
                            }),
                          ]),
                        ),
                      }),
                    }),
                  }),
                ]),
            }),
          ),
        ],
        [Location.node, location],
        [PermissionV2.node, permission],
        [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
      ]),
    )
    collisionIt.live(
      `keeps collision pair ${entries[0][0]} / ${entries[1][0]} stable through reverse connection and reconnect`,
      () =>
        Effect.gen(function* () {
          const mcp = yield* MCP.Service
          const registry = yield* ToolRegistry.Service
          const identities = new Map<string, string>()
          for (const order of [entries, entries.toReversed(), entries]) {
            for (const [server] of entries) yield* mcp.disconnect(server)
            yield* mcp.reconnect(order[0][0])
            const readable = `mcp_${order[0][0].replace(/[^A-Za-z0-9_-]/g, "_")}_${order[0][1].replace(/[^A-Za-z0-9_-]/g, "_")}`
            if (readable.length <= 64) expect((yield* mcp.instructions())[0].tools).toEqual([readable])
            yield* mcp.reconnect(order[1][0])
            const instructions = yield* mcp.instructions()
            const names = instructions.flatMap((item) => item.tools)
            expect(names).toHaveLength(2)
            expect(new Set(names).size).toBe(2)
            for (const [server, tool] of entries) {
              const name = instructions.find((item) => item.name === server)!.tools[0]
              expect(name.length).toBeLessThanOrEqual(64)
              expect(name).toMatch(/^[A-Za-z0-9_-]+$/)
              expect(name).toMatch(/_[a-f0-9]{16}$/)
              expect((yield* toolDefinitions(registry)).some((item) => item.name === name)).toBe(true)
              if (identities.has(server)) expect(name).toBe(identities.get(server)!)
              identities.set(server, name)
              expect(
                yield* executeTool(registry, {
                  sessionID,
                  ...toolIdentity,
                  call: { type: "tool-call", id: `call-${server}`, name, input: { text: "route" } },
                }),
              ).toEqual({ type: "text", value: `${server}:${tool}:route` })
            }
          }
        }),
      30000,
    )
  }

  it.live("retains oversized MCP isError output as error evidence", () =>
    Effect.gen(function* () {
      const mcp = yield* MCP.Service
      yield* mcp.status()
      const registry = yield* ToolRegistry.Service
      const evidence = yield* Evidence.Service
      const message = "MCP failure: " + "x".repeat(60_000)
      const result = yield* settleTool(registry, {
        sessionID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "mcp-error",
          name: "mcp_fixture_echo",
          input: { text: `error:${message}` },
        },
      })
      expect(result.inputRejected).toBe(false)
      expect(result.output).toBeUndefined()
      expect(result.outputPaths).toHaveLength(1)
      expect(result.result.type).toBe("error")
      if (result.result.type !== "error") throw new Error("expected MCP error")
      expect(Buffer.byteLength(result.result.value)).toBeLessThanOrEqual(ToolOutputStore.MAX_BYTES)
      const id = Evidence.reference(sessionID, result.outputPaths![0])
      expect(result.result.value).toContain(id)
      const first = yield* evidence.read(sessionID, id, 0, 32768)
      const second = yield* evidence.read(sessionID, id, first.nextOffset!, 32768)
      expect(first.text + second.text).toBe(message)
    }),
  )

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
          call: {
            type: "tool-call",
            id: "call-mcp",
            name: "mcp_fixture_echo",
            input: { text: "stable" },
          },
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
