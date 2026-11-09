import { expect, test } from "bun:test"
import path from "node:path"
import { Effect, Fiber, Layer } from "effect"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { Config } from "../src/config"
import { ConfigMCP } from "../src/config/mcp"
import { Global } from "../src/global"
import { Location } from "../src/location"
import { ProjectV2 } from "../src/project"
import { AbsolutePath } from "../src/schema"
import { SessionV2 } from "../src/session"
import { MCP } from "../src/mcp"
import { PermissionV2 } from "../src/permission"
import { ApplicationTools } from "../src/tool/application-tools"
import { ToolOutputStore } from "../src/tool-output-store"
import { ToolRegistry } from "../src/tool/registry"
import { settleTool, toolIdentity } from "./lib/tool"
import { tmpdir } from "./fixture/tmpdir"

for (const mode of [
  "valid",
  "no-schema",
  "mismatch",
  "missing",
  "missing-text",
  "enum",
  "structured",
  "unsupported",
  "error",
  "required",
  "rpc-error",
  "timeout",
  "cancel",
  "invalid-input",
]) {
  test(
    "751 MCP output boundary retains one dispatch: " + mode,
    async () => {
      await using tmp = await tmpdir()
      const counter = path.join(tmp.path, "calls.txt")
      const directory = AbsolutePath.make(tmp.path)
      const config = new Config.Document({
        type: "document",
        info: new Config.Info({
          mcp: new ConfigMCP.Info({
            servers: {
              fixture: new ConfigMCP.Local({
                type: "local",
                command: [process.execPath, path.join(import.meta.dir, "fixture/mcp-canonical-stdio.ts")],
                environment: { MCP_TEST_OUTPUT_MODE: mode, MCP_TEST_CALL_FILE: counter },
                timeout: new ConfigMCP.Timeout({ request: 50 }),
              }),
            },
          }),
        }),
      })
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const registry = yield* ToolRegistry.Service
            const call = settleTool(registry, {
              sessionID: SessionV2.ID.make("ses_output"),
              ...toolIdentity,
              call: {
                type: "tool-call",
                id: "output",
                name: "mcp_fixture_echo",
                input: mode === "invalid-input" ? {} : { text: "fixture" },
              },
            })
            if (mode === "cancel") {
              const fiber = yield* call.pipe(Effect.forkChild)
              for (let i = 0; i < 100 && !(yield* Effect.promise(() => Bun.file(counter).exists())); i++)
                yield* Effect.sleep(5)
              yield* Fiber.interrupt(fiber)
              expect(Number(yield* Effect.promise(() => Bun.file(counter).text()))).toBe(1)
              return
            }
            const result = yield* call
            if (["error", "required", "rpc-error", "timeout", "invalid-input"].includes(mode)) {
              expect(result.result.type).toBe("error")
              expect(JSON.stringify(result)).not.toContain("outputSchemaDiagnostic")
            } else {
              expect(result.result.type).not.toBe("error")
              if (mode === "valid" || mode === "no-schema")
                expect(result.output?.structured).toEqual({ echo: mode === "valid" ? "ok" : 123 })
              else {
                expect(JSON.stringify(result.output?.structured)).toContain("outputSchemaDiagnostic")
                expect(JSON.stringify(result.result)).toContain("MCP output schema")
                if (mode !== "missing" && mode !== "missing-text")
                  expect(result.output?.structured).toMatchObject({
                    unvalidated: { echo: mode === "enum" ? "other" : 123 },
                  })
              }
            }
            const calls = yield* Effect.promise(async () =>
              (await Bun.file(counter).exists()) ? Number(await Bun.file(counter).text()) : 0,
            )
            expect(calls).toBe(mode === "required" || mode === "invalid-input" ? 0 : 1)
          }).pipe(
            Effect.provide(
              AppNodeBuilder.build(LayerNode.group([ApplicationTools.node, ToolRegistry.node, MCP.node]), [
                [
                  Config.node,
                  Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed([config]) })),
                ],
                [
                  Global.node,
                  Global.layerWith({
                    config: path.join(tmp.path, "config"),
                    data: path.join(tmp.path, "data"),
                    state: path.join(tmp.path, "state"),
                  }),
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
              ]),
            ),
          ),
        ),
      )
    },
    10000,
  )
}
