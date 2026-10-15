import path from "path"
import { expect } from "bun:test"
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
import { Effect, Fiber, Layer } from "effect"
import { executeTool, toolIdentity } from "./lib/tool"
import { testEffect } from "./lib/effect"
import { SessionV2 } from "@zaovra-ai/core/session"
import { SystemContextRegistry } from "@zaovra-ai/core/system-context/registry"

import { Database } from "@zaovra-ai/core/database/database"
import { EventV2 } from "@zaovra-ai/core/event"
import { SessionStore } from "@zaovra-ai/core/session/store"
import { SessionTable } from "@zaovra-ai/core/session/sql"
import { ProjectTable } from "@zaovra-ai/core/project/sql"
import { AgentV2 } from "@zaovra-ai/core/agent"
const directory = AbsolutePath.make(path.resolve(import.meta.dirname, "fixture"))
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
                  environment: { MCP_TEST_APPROVAL: "1" },
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

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      ApplicationTools.node,
      Integration.node,
      SystemContextRegistry.node,
      ToolRegistry.node,
      MCP.node,
      Evidence.node,
      Database.node,
      EventV2.node,
      SessionStore.node,
      PermissionV2.node,
      AgentV2.node,
    ]),
    [
      [Config.node, config],
      [Location.node, location],
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
    ],
  ),
)

it.live(
  "real MCP approval captures validated arguments, redacts metadata and requires a new corrected call",
  () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const agents = yield* AgentV2.Service
      const registry = yield* ToolRegistry.Service
      const permission = yield* PermissionV2.Service
      const events = yield* EventV2.Service
      const sessionID = SessionV2.ID.make("ses_mcp_approval")
      yield* database.db
        .insert(ProjectTable)
        .values({ id: ProjectV2.ID.global, worktree: directory, sandboxes: [] })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* database.db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: ProjectV2.ID.global,
          slug: "approval",
          directory,
          title: "MCP approval",
          version: "test",
          agent: "test",
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* agents.transform((editor) =>
        editor.update(AgentV2.ID.make("build"), (agent) => {
          agent.permissions = [{ action: "*", resource: "*", effect: "ask" }]
        }),
      )
      const requests: PermissionV2.Request[] = []
      const unsubscribe = yield* events.listen((event) =>
        Effect.sync(() => {
          if (event.type === PermissionV2.Event.Asked.type) requests.push(event.data as PermissionV2.Request)
        }),
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      const rejected = yield* registry.materialize().pipe(
        Effect.flatMap((tools) =>
          tools.settle({
            sessionID,
            ...toolIdentity,
            call: { type: "tool-call", id: "bad", name: "mcp_fixture_echo", input: { text: 42 } },
          }),
        ),
      )
      expect(rejected.inputRejected).toBe(true)
      expect(requests).toEqual([])
      const input = {
        text: "approved",
        apiKey: "fixture-secret",
        nested: { password: "fixture-password", safe: "visible", items: [{ token: "fixture-token" }] },
      }
      const call = (id: string, value: typeof input) =>
        executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id, name: "mcp_fixture_echo", input: value },
        })
      const approved = structuredClone(input)
      const first = yield* call("first", input).pipe(Effect.forkScoped)
      yield* Effect.repeat(Effect.sleep("10 millis"), { until: () => requests.length === 1 })
      const request = requests[0]
      expect(request.source).toEqual({ type: "tool", messageID: toolIdentity.assistantMessageID, callID: "first" })
      expect(request.metadata).toEqual({
        mcpServer: "fixture",
        mcpTool: "echo",
        mcpArguments: {
          text: "approved",
          apiKey: "[REDACTED]",
          nested: { password: "[REDACTED]", safe: "visible", items: [{ token: "[REDACTED]" }] },
        },
      })
      input.text = "mutated-after-prompt"
      input.nested.safe = "mutated-nested"
      yield* permission.reply({ requestID: request.id, reply: "once" })
      expect(yield* Fiber.join(first)).toEqual({
        type: "text",
        value: JSON.stringify({ arguments: approved, calls: 1 }),
      })
      const second = yield* call("corrected", { ...input, text: "corrected" }).pipe(Effect.forkScoped)
      yield* Effect.repeat(Effect.sleep("10 millis"), { until: () => requests.length === 2 })
      expect(requests[1].id).not.toBe(request.id)
      expect(requests[1].source?.type === "tool" && requests[1].source.callID).toBe("corrected")
      expect(requests[1].metadata?.mcpArguments).toMatchObject({ text: "corrected" })
      const stale = yield* permission.reply({ requestID: request.id, reply: "once" }).pipe(Effect.exit)
      expect(stale._tag).toBe("Failure")
      expect((yield* permission.list()).length).toBe(1)
      yield* permission.reply({ requestID: requests[1].id, reply: "reject", message: "Use final text instead" })
      expect(yield* Fiber.join(second)).toEqual({ type: "error", value: "Use final text instead" })
      const third = yield* call("final", { ...input, text: "final" }).pipe(Effect.forkScoped)
      yield* Effect.repeat(Effect.sleep("10 millis"), { until: () => requests.length === 3 })
      expect(requests[2].id).not.toBe(requests[1].id)
      expect(requests[2].metadata?.mcpArguments).toMatchObject({ text: "final" })
      yield* permission.reply({ requestID: requests[2].id, reply: "once" })
      expect(yield* Fiber.join(third)).toEqual({
        type: "text",
        value: JSON.stringify({ arguments: { ...input, text: "final" }, calls: 2 }),
      })
      const long = yield* call("long", { ...input, text: "long-argument".repeat(80) }).pipe(Effect.forkScoped)
      yield* Effect.repeat(Effect.sleep("10 millis"), { until: () => requests.length === 4 })
      yield* permission.reply({ requestID: requests[3].id, reply: "once" })
      expect(yield* Fiber.join(long)).toEqual({
        type: "text",
        value: JSON.stringify({ arguments: { ...input, text: "long-argument".repeat(80) }, calls: 3 }),
      })
      if (process.env.W_MCP_EVIDENCE)
        yield* Effect.promise(() => Bun.write(process.env.W_MCP_EVIDENCE!, JSON.stringify(requests, null, 2)))
    }),
  20000,
)
