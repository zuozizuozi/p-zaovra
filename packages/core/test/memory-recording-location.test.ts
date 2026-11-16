import { expect, test } from "bun:test"
import path from "node:path"
import { DateTime, Effect, Layer } from "effect"
import { Config } from "../src/config"
import { Database } from "../src/database/database"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { EventV2 } from "../src/event"
import { Global } from "../src/global"
import { Location } from "../src/location"
import { MemoryContext } from "../src/memory/context"
import { MemoryPages } from "../src/memory/pages"
import { MemoryRecorder } from "../src/memory/recorder"
import { MemoryStore } from "../src/memory/store"
import { ProjectV2 } from "../src/project"
import { ProjectTable } from "../src/project/sql"
import { AbsolutePath } from "../src/schema"
import { SessionSchema } from "../src/session/schema"
import { SessionEvent } from "../src/session/event"
import { SessionMessage } from "../src/session/message"
import { SessionTable } from "../src/session/sql"
import { tmpdir } from "./fixture/tmpdir"

for (const firstEnabled of [false, true]) {
  test(`recording uses the source Location after ${firstEnabled ? "on/off" : "off/on"} initialization`, async () => {
    await using temp = await tmpdir()
    await Effect.gen(function* () {
      const memory = yield* MemoryStore.Service
      const pages = yield* MemoryPages.Service
      const database = yield* Database.Service
      const project = ProjectV2.ID.make("recording-shared-project")
      yield* database.db
        .insert(ProjectTable)
        .values({ id: project, worktree: AbsolutePath.make(temp.path), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      for (const enabled of [firstEnabled, !firstEnabled]) {
        const directory = AbsolutePath.make(path.join(temp.path, enabled ? "enabled" : "disabled"))
        const sessionID = SessionSchema.ID.make(enabled ? "ses_recording_enabled" : "ses_recording_disabled")
        yield* database.db
          .insert(SessionTable)
          .values({
            id: sessionID,
            project_id: project,
            slug: sessionID,
            directory,
            title: "recording isolation",
            version: "test",
            agent: "test",
          })
          .run()
          .pipe(Effect.orDie)
        // Construct the real Location context twice while keeping its actual global store shared.
        yield* Layer.build(
          Layer.fresh(
            AppNodeBuilder.build(MemoryContext.node, [
              [MemoryStore.node, Layer.succeed(MemoryStore.Service, memory)],
              [MemoryPages.node, Layer.succeed(MemoryPages.Service, pages)],
              [MemoryRecorder.node, Layer.empty],
              [
                Location.node,
                Layer.succeed(Location.Service, {
                  directory,
                  project: { id: project, directory: AbsolutePath.make(temp.path) },
                }),
              ],
              [
                Config.node,
                Layer.succeed(
                  Config.Service,
                  Config.Service.of({
                    entries: () =>
                      Effect.succeed([
                        new Config.Document({ type: "document", info: new Config.Info({ memory: { enabled } }) }),
                      ]),
                  }),
                ),
              ],
            ]),
          ),
        )
      }
      const results = []
      for (const enabled of [false, true]) {
        results.push(
          (yield* memory.observe({
            scope: MemoryStore.scope({ project, directory: temp.path }),
            kind: "preference",
            key: enabled ? "enabled-source" : "disabled-source",
            text: enabled ? "Always use enabled source" : "Never record disabled source",
            verification: MemoryStore.said,
            settled: true,
            sessionID: SessionSchema.ID.make(enabled ? "ses_recording_enabled" : "ses_recording_disabled"),
          })) !== undefined,
        )
      }
      expect(results).toEqual([false, true])
      const events = yield* EventV2.Service
      for (const enabled of [false, true]) {
        yield* events.publish(SessionEvent.Prompted, {
          timestamp: yield* DateTime.now,
          sessionID: SessionSchema.ID.make(enabled ? "ses_recording_enabled" : "ses_recording_disabled"),
          messageID: SessionMessage.ID.create(),
          prompt: { text: enabled ? "Always use the event sentinel" : "Never record the disabled event" },
          delivery: "steer",
        })
      }
      const scope = MemoryStore.scope({ project, directory: temp.path })
      // One serial recorder consumes the disabled event before this sentinel.
      const notes = yield* Effect.gen(function* () {
        while (true) {
          const current = yield* memory.list(scope)
          if (current.some((note) => note.text === "Always use the event sentinel")) return current
          yield* Effect.sleep("10 millis")
        }
      }).pipe(Effect.timeout("5 seconds"))
      expect(notes.some((note) => note.text === "Never record the disabled event")).toBe(false)
      yield* memory.silence(scope, true, { directory: path.join(temp.path, "enabled") })
      yield* memory.silence(scope, false, { directory: path.join(temp.path, "disabled") })
      const changed = []
      for (const enabled of [false, true]) {
        changed.push(
          (yield* memory.observe({
            scope,
            kind: "preference",
            key: `changed-${enabled}`,
            text: `recording changed ${enabled}`,
            verification: MemoryStore.said,
            settled: true,
            sessionID: SessionSchema.ID.make(enabled ? "ses_recording_enabled" : "ses_recording_disabled"),
          })) !== undefined,
        )
      }
      expect(changed).toEqual([true, false])
    }).pipe(
      Effect.scoped,
      Effect.provide(
        AppNodeBuilder.build(
          LayerNode.group([MemoryStore.node, MemoryPages.node, MemoryRecorder.node, Database.node, EventV2.node]),
          [
            [Database.node, Database.layerFromPath(path.join(temp.path, "memory.db"))],
            [
              Global.node,
              Global.layerWith({
                data: path.join(temp.path, "data"),
                config: path.join(temp.path, "config"),
                state: path.join(temp.path, "state"),
              }),
            ],
          ],
        ),
      ),
      Effect.runPromise,
    )
  })
}
