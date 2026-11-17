import { expect, test } from "bun:test"
import path from "node:path"
import { DateTime, Effect, Layer, ManagedRuntime } from "effect"
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
import { SessionEvent } from "../src/session/event"
import { SessionExecution } from "../src/session/execution"
import { SessionMessage } from "../src/session/message"
import { SystemContextRegistry } from "../src/system-context/registry"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"

test("memory index stays local to an admitted epoch across another session and restart, then refreshes on compaction", async () => {
  await using temp = await tmpdir()
  const runtime = () =>
    ManagedRuntime.make(
      AppNodeBuilder.build(
        LayerNode.group([
          MemoryContext.node,
          MemoryStore.node,
          SessionV2.node,
          Location.node,
          SystemContextRegistry.node,
          Database.node,
          EventV2.node,
        ]),
        [
          [Location.node, Layer.succeed(Location.Service, location({ directory: AbsolutePath.make(temp.path) }))],
          [Database.node, Database.layerFromPath(path.join(temp.path, "epochs.db"))],
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
                    new Config.Document({ type: "document", info: new Config.Info({ memory: { enabled: true } }) }),
                  ]),
              }),
            ),
          ],
        ],
      ),
    )
  const first = runtime()
  const saved = await first
    .runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionV2.Service
        const memory = yield* MemoryStore.Service
        const registry = yield* SystemContextRegistry.Service
        const database = yield* Database.Service
        const events = yield* EventV2.Service
        const here = yield* Location.Service
        const scope = yield* memory.scope({ project: here.project.id, directory: here.directory })
        const note = yield* memory.write({
          scope,
          kind: "convention",
          text: "original memory text",
          origin: "user",
          status: "verified",
        })
        if (!note) throw new Error("fixture note missing")
        const dependent = (yield* memory.write({
          scope,
          kind: "practice",
          text: "File dependent historical memory",
          origin: "user",
          status: "verified",
        }))!
        const a = yield* sessions.create({ location: { directory: here.directory } })
        const before = yield* SessionContextEpoch.initialize(database.db, registry.load(), a.id)
        if (!before) throw new Error("fixture epoch missing")
        expect(before.baseline).toContain("original memory text")
        expect(before.baseline).toContain("File dependent historical memory")
        yield* memory.bindFiles({
          scope,
          id: dependent.id,
          expectedRevision: 0,
          files: [
            {
              path: "source.txt",
              directory: here.directory,
              identity: "storage-fixture",
              digest: "a".repeat(64),
              bytes: 1,
              sessionID: a.id,
              seq: 1,
            },
          ],
        })
        yield* memory.checkFiles({
          scope,
          id: dependent.id,
          expectedRevision: 1,
          results: [{ path: "source.txt", state: "unchanged" }],
        })

        yield* memory.edit(note.id, { text: "new memory text" })
        const b = yield* sessions.create({ location: { directory: here.directory } })
        const newer = yield* SessionContextEpoch.initialize(database.db, registry.load(), b.id)
        expect(newer?.baseline).toContain("new memory text")
        expect(newer?.baseline).not.toContain("original memory text")
        expect(newer?.baseline).not.toContain("File dependent historical memory")
        expect(yield* SessionContextEpoch.prepare(database.db, events, registry.load(), a.id)).toEqual(before)
        expect((yield* sessions.context(a.id)).some((message) => message.type === "system")).toBe(false)
        return { id: a.id, before, note: note.id }
      }),
    )
    .finally(() => first.dispose())
  const second = runtime()
  await second
    .runPromise(
      Effect.gen(function* () {
        const database = yield* Database.Service
        const registry = yield* SystemContextRegistry.Service
        const events = yield* EventV2.Service
        const memory = yield* MemoryStore.Service
        expect(yield* SessionContextEpoch.prepare(database.db, events, registry.load(), saved.id)).toEqual(saved.before)
        yield* memory.remove(saved.note)
        expect(yield* SessionContextEpoch.prepare(database.db, events, registry.load(), saved.id)).toEqual(saved.before)
        yield* events.publish(SessionEvent.Compaction.Ended, {
          sessionID: saved.id,
          timestamp: DateTime.makeUnsafe(0),
          messageID: SessionMessage.ID.create(),
          reason: "manual",
          text: "summary",
          recent: "",
        })
        const compacted = yield* SessionContextEpoch.prepare(database.db, events, registry.load(), saved.id)
        expect(compacted.baseline).not.toContain("original memory text")
        expect(compacted.baseline).not.toContain("new memory text")
        expect(compacted.baseline).toContain("No notes yet.")
        expect(compacted.baselineSeq).toBeGreaterThan(saved.before.baselineSeq)
      }),
    )
    .finally(() => second.dispose())
})
