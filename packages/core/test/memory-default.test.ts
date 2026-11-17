import { expect, test } from "bun:test"
import path from "node:path"
import { Effect, Layer, ManagedRuntime } from "effect"
import { Config } from "../src/config"
import { Database } from "../src/database/database"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { EventV2 } from "../src/event"
import { Global } from "../src/global"
import { Location } from "../src/location"
import { MemoryContext } from "../src/memory/context"
import { MemoryStore } from "../src/memory/store"
import { AbsolutePath } from "../src/schema"
import { SessionV2 } from "../src/session"
import { SessionContextEpoch } from "../src/session/context-epoch"
import { SessionExecution } from "../src/session/execution"
import { SystemContextRegistry } from "../src/system-context/registry"
import { MemoryTool } from "../src/tool/memory"
import { MemoryCheckTool } from "../src/tool/memory-check"
import { ToolRegistry } from "../src/tool/registry"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"

for (const item of [
  { name: "missing memory configuration", memory: undefined, enabled: false },
  { name: "empty memory configuration", memory: {}, enabled: false },
  { name: "explicitly disabled memory", memory: { enabled: false }, enabled: false },
  { name: "explicitly enabled memory", memory: { enabled: true }, enabled: true },
]) {
  test(`${item.name} controls context, recording and tool availability without deleting notes`, async () => {
    await using temp = await tmpdir()
    const runtime = ManagedRuntime.make(
      AppNodeBuilder.build(
        LayerNode.group([
          MemoryStore.node,
          MemoryContext.node,
          MemoryTool.node,
          MemoryCheckTool.node,
          ToolRegistry.node,
          SessionV2.node,
          Database.node,
          EventV2.node,
          Location.node,
          SystemContextRegistry.node,
        ]),
        [
          [Location.node, Layer.succeed(Location.Service, location({ directory: AbsolutePath.make(temp.path) }))],
          [Database.node, Database.layerFromPath(path.join(temp.path, "default.db"))],
          [SessionExecution.node, SessionExecution.noopLayer],
          [
            Global.node,
            Global.layerWith({
              data: path.join(temp.path, "data"),
              config: path.join(temp.path, "config"),
              state: path.join(temp.path, "state"),
            }),
          ],
          [
            Config.node,
            Layer.succeed(
              Config.Service,
              Config.Service.of({
                entries: () =>
                  Effect.succeed([
                    new Config.Document({ type: "document", info: new Config.Info({ memory: item.memory }) }),
                  ]),
              }),
            ),
          ],
        ],
      ),
    )
    await runtime
      .runPromise(
        Effect.gen(function* () {
          const sessions = yield* SessionV2.Service
          const memory = yield* MemoryStore.Service
          const registry = yield* SystemContextRegistry.Service
          const tools = yield* ToolRegistry.Service
          const database = yield* Database.Service
          const here = yield* Location.Service
          const scope = yield* memory.scope({ project: here.project.id, directory: here.directory })
          const existing = yield* memory.write({
            scope,
            kind: "preference",
            text: "Previously saved user note",
            origin: "user",
            status: "verified",
          })
          expect(existing).toBeDefined()
          const session = yield* sessions.create({ location: { directory: here.directory } })
          const epoch = yield* SessionContextEpoch.initialize(database.db, registry.load(), session.id)
          expect(epoch?.baseline.includes("Previously saved user note") ?? false).toBe(item.enabled)
          const observed = yield* memory.observe({
            scope,
            kind: "preference",
            key: "default-observation",
            text: "Always keep the output concise",
            verification: MemoryStore.said,
            sessionID: session.id,
            settled: true,
          })
          expect(observed !== undefined).toBe(item.enabled)
          const captured = yield* tools.materialize()
          expect(captured.definitions.some((tool) => tool.name === "memory_search")).toBe(item.enabled)
          expect(captured.definitions.some((tool) => tool.name === "memory_check")).toBe(item.enabled)
          expect((yield* memory.get(existing!.id))?.text).toBe("Previously saved user note")
        }),
      )
      .finally(() => runtime.dispose())
  }, 30000)
}
