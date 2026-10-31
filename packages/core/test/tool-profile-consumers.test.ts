import { describe, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { AppProcess } from "../src/process"
import { Config } from "../src/config"
import { ConfigExperimental } from "../src/config/experimental"
import { Location } from "../src/location"
import { Snapshot } from "../src/snapshot"
import { PermissionV2 } from "../src/permission"
import { EventV2 } from "../src/event"
import { AbsolutePath } from "../src/schema"
import { ToolRegistry } from "../src/tool/registry"
import { ToolSearch } from "../src/tool/tool-search"
import { BashTool } from "../src/tool/bash"
import { ToolProfile } from "../src/session/tool-profile"
import { ToolOutputStore } from "../src/tool-output-store"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { toolIdentity } from "./lib/tool"
import { SessionV2 } from "../src/session"
import { testEffect } from "./lib/effect"
const it = testEffect(Layer.empty)
describe("P2 keeps lightweight-delivery consumers", () => {
  for (const verification of [false, true])
    for (const delivery_contract of [false, true]) {
      it.live("retains and consumes old explicit fields with V=" + verification + " D=" + delivery_contract, () =>
        Effect.acquireUseRelease(
          Effect.promise(() => tmpdir()),
          (tmp) =>
            Effect.gen(function* () {
              yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "source.txt"), "source"))
              yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "assertion.test.ts"), "assert source"))
              const registry = yield* ToolRegistry.Service
              const all = (yield* registry.materialize()).definitions
              const selected = ToolProfile.select(all, { model: "gpt-6-luna", history: [] })
              const bash = selected.find((tool) => tool.name === "bash")!
              expect(bash).toBe(all.find((tool) => tool.name === "bash")!)
              expect(JSON.stringify(bash.inputSchema)).toContain("verification_targets")
              expect(JSON.stringify(bash.inputSchema)).toContain("verification_assertions")
              expect(JSON.stringify(bash.inputSchema)).toContain("verification_requirements")
              const materialization = yield* registry.materialize()
              const result = yield* materialization.settle({
                sessionID: SessionV2.ID.make("ses_profile_matrix"),
                ...toolIdentity,
                call: {
                  type: "tool-call",
                  id: "check",
                  name: "bash",
                  input: {
                    command: "echo check",
                    verification: "test",
                    verification_targets: ["source.txt", "assertion.test.ts"],
                    verification_assertions: ["assertion.test.ts"],
                    verification_requirements: ["kept contract"],
                  },
                },
              })
              expect(result.result.type).not.toBe("error")
              expect(result.output?.structured).toMatchObject({
                verification: {
                  exit: 0,
                  requirements: ["kept contract"],
                  targets: expect.arrayContaining([
                    expect.objectContaining({ path: path.join(tmp.path, "source.txt") }),
                  ]),
                  assertions: expect.arrayContaining([
                    expect.objectContaining({ path: path.join(tmp.path, "assertion.test.ts") }),
                  ]),
                },
              })
            }).pipe(
              Effect.provide(
                AppNodeBuilder.build(LayerNode.group([BashTool.node, ToolSearch.node, ToolRegistry.node]), [
                  [
                    Location.node,
                    Layer.succeed(
                      Location.Service,
                      Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) })),
                    ),
                  ],
                  [PermissionV2.node, Layer.mock(PermissionV2.Service, { assert: () => Effect.void })],
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
                                  verification,
                                  delivery_contract,
                                  quality_progress: { stagnation_log: false },
                                }),
                              }),
                            }),
                          ]),
                      }),
                    ),
                  ],
                  [Snapshot.node, Snapshot.noopLayer],
                  [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
                  [
                    AppProcess.node,
                    Layer.mock(AppProcess.Service, {
                      run: () =>
                        Effect.succeed({
                          command: "fixture",
                          exitCode: 0,
                          output: Buffer.from("passed"),
                          stdout: Buffer.from("passed"),
                          stderr: Buffer.alloc(0),
                          outputTruncated: false,
                          stdoutTruncated: false,
                          stderrTruncated: false,
                        }),
                    }),
                  ],
                  [
                    EventV2.node,
                    Layer.mock(EventV2.Service, {
                      listen: () => Effect.succeed(Effect.void),
                      recentAfter: () => ({ events: [], complete: false }),
                      publish: (definition, data) =>
                        Effect.succeed({ id: EventV2.ID.create(), type: definition.type, data } as EventV2.Payload<
                          typeof definition
                        >),
                    }),
                  ],
                ]),
              ),
            ),
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
        ),
      )
    }
})
