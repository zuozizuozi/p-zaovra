import { expect, spyOn, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import path from "path"
import { Effect, Exit, Layer } from "effect"
import { Config } from "@zaovra-ai/core/config"
import { ConfigMCP } from "@zaovra-ai/core/config/mcp"
import { AppNodeBuilder } from "@zaovra-ai/core/effect/app-node-builder"
import { LayerNode } from "@zaovra-ai/core/effect/layer-node"
import { Location } from "@zaovra-ai/core/location"
import { MCP } from "@zaovra-ai/core/mcp"
import { PermissionV2 } from "@zaovra-ai/core/permission"
import { ProjectV2 } from "@zaovra-ai/core/project"
import { AbsolutePath } from "@zaovra-ai/core/schema"
import { ToolOutputStore } from "@zaovra-ai/core/tool-output-store"
import { ApplicationTools } from "@zaovra-ai/core/tool/application-tools"
import { ToolRegistry } from "@zaovra-ai/core/tool/registry"
import { SessionV2 } from "@zaovra-ai/core/session"
import { executeTool, toolIdentity } from "./lib/tool"

const directory = AbsolutePath.make(path.resolve(import.meta.dirname, "fixture"))

test.each([100, 120_000])("progress renews the idle deadline but has a total cap (request=%d)", async (timeout) => {
  // Calls through to the real SDK and stdio server; inspect the actual dispatch options without a ten-minute test.
  const requests = spyOn(Client.prototype, "request")
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        const result = yield* executeTool(registry, {
          sessionID: SessionV2.ID.make("ses_mcp_deadline"),
          ...toolIdentity,
          call: { type: "tool-call", id: "call-deadline", name: "mcp_fixture_echo", input: { text: "ok" } },
        })
        expect(result.type).toBe("text")
        const sent = requests.mock.calls.findLast(([request]) => request.method === "tools/call")
        expect(sent?.[2]).toMatchObject({
          timeout,
          resetTimeoutOnProgress: true,
          maxTotalTimeout: Math.max(timeout * 10, 600_000),
        })
      }).pipe(
        Effect.provide(
          layer(
            new ConfigMCP.Info({
              servers: {
                fixture: new ConfigMCP.Local({
                  type: "local",
                  command: [process.execPath, path.join(directory, "mcp-canonical-stdio.ts")],
                  timeout: new ConfigMCP.Timeout({ request: timeout }),
                }),
              },
            }),
          ),
        ),
        Effect.scoped,
      ),
    )
  } finally {
    requests.mockRestore()
  }
})
function layer(mcp: ConfigMCP.Info) {
  return AppNodeBuilder.build(LayerNode.group([ApplicationTools.node, ToolRegistry.node, MCP.node]), [
    [
      Config.node,
      Layer.succeed(
        Config.Service,
        Config.Service.of({
          entries: () => Effect.succeed([new Config.Document({ type: "document", info: new Config.Info({ mcp }) })]),
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
    [PermissionV2.node, Layer.mock(PermissionV2.Service, { assert: () => Effect.void })],
    [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
  ])
}

test("startup deadline closes SSE without an endpoint and reports failed", async () => {
  const state = { opened: false, closed: false }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (request.method !== "GET") return new Response(null, { status: 405 })
      return new Response(
        new ReadableStream({
          start(controller) {
            state.opened = true
            controller.enqueue(new TextEncoder().encode(": waiting for endpoint\n\n"))
          },
          cancel() {
            state.closed = true
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      )
    },
  })
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        const result = yield* mcp.reconnect("slow").pipe(Effect.timeout(1500), Effect.exit)
        expect(state.opened).toBe(true)
        expect(Exit.isSuccess(result)).toBe(true)
        const status = yield* mcp.status()
        expect(status.slow.status).toBe("failed")
        if (status.slow.status === "failed") expect(status.slow.error).toMatch(/timed out/i)
        yield* Effect.sleep(30)
        expect(state.closed).toBe(true)
      }).pipe(
        Effect.provide(
          layer(
            new ConfigMCP.Info({
              servers: {
                slow: new ConfigMCP.Remote({
                  type: "remote",
                  url: `http://127.0.0.1:${server.port}/mcp`,
                  oauth: false,
                  disabled: true,
                  timeout: new ConfigMCP.Timeout({ startup: 100 }),
                }),
              },
            }),
          ),
        ),
        Effect.scoped,
      ),
    )
  } finally {
    await server.stop(true)
  }
})
