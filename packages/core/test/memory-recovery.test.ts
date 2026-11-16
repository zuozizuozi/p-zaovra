import { expect, test } from "bun:test"
import path from "node:path"
import { DateTime, Effect, Layer, ManagedRuntime } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "../src/database/database"
import { MemoryStore } from "../src/memory/store"
import { MemoryNoteTable } from "../src/memory/sql"
import { Memory } from "@zaovra-ai/schema/memory"
import { Project } from "../src/project"
import { SessionSchema } from "../src/session/schema"
import { Hash } from "../src/util/hash"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { EventV2 } from "../src/event"
import { MemoryRecorder } from "../src/memory/recorder"
import { MemoryTool } from "../src/tool/memory"
import { ToolRegistry } from "../src/tool/registry"
import { Config } from "../src/config"
import { Catalog } from "../src/catalog"
import { ModelV2 } from "../src/model"
import { ProviderV2 } from "../src/provider"
import { ModelMemoryProfile } from "../src/model-memory-profile"
import { Location } from "../src/location"
import { AbsolutePath } from "../src/schema"
import { ProjectTable } from "../src/project/sql"
import { SessionTable } from "../src/session/sql"
import { SessionEvent } from "../src/session/event"
import { SessionMessage } from "../src/session/message"
import { SessionProjector } from "../src/session/projector"
import { toolIdentity } from "./lib/tool"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"

const left = { project: Project.ID.global, directory: "/Recovery/Alpha" }
const right = { project: Project.ID.global, directory: "/Recovery/alpha" }
const old = MemoryStore.scope(left, "win32")
const content = { kind: "practice" as const, origin: "model" as const, status: "unverified" as const }
const live = Memory.ID.make("mem_legacy_live")
const deleted = Memory.ID.make("mem_legacy_deleted")
const seed = Effect.gen(function* () {
  const database = yield* Database.Service
  yield* database.db
    .insert(MemoryNoteTable)
    .values([
      { ...content, id: live, scope: old, key: "fact-live", text: "Useful old note", time_observed: 1 },
      { ...content, id: deleted, scope: old, key: "original-deleted-key", text: "", time_observed: 1, time_deleted: 1 },
      {
        ...content,
        id: Memory.ID.make("mem_legacy_alias"),
        scope: old,
        key: `deleted-text:${Hash.fast("deleted wording")}`,
        text: "",
        time_observed: 1,
        time_deleted: 1,
      },
    ])
    .run()
    .pipe(Effect.orDie)
})
const snapshot = Effect.gen(function* () {
  const database = yield* Database.Service
  return yield* database.db
    .select()
    .from(MemoryNoteTable)
    .where(eq(MemoryNoteTable.scope, old))
    .all()
    .pipe(Effect.orDie)
})
const runtime = (file: string, platform: NodeJS.Platform = "linux") =>
  ManagedRuntime.make(MemoryStore.layerWith(platform).pipe(Layer.provideMerge(Database.layerFromPath(file))))

test("recovery survives restart, requires each directory's explicit choice and preserves old originals", async () => {
  await using temp = await tmpdir()
  const file = path.join(temp.path, "recovery.db")
  const first = runtime(file)
  const before = await first
    .runPromise(
      Effect.gen(function* () {
        yield* seed
        const original = yield* snapshot
        const store = yield* MemoryStore.Service
        const scope = yield* store.scope(left)
        expect((yield* store.recovery(left)).frozen).toBe(true)
        expect(yield* store.write({ ...content, scope, text: "blocked model write" })).toBeUndefined()
        expect(yield* store.write({ ...content, origin: "user", scope, text: "blocked HTTP write" })).toBeUndefined()
        expect(
          yield* store.observe({
            scope,
            kind: "practice",
            key: "new",
            text: "blocked observation",
            verification: "test",
            sessionID: SessionSchema.ID.make("ses_test"),
          }),
        ).toBeUndefined()
        expect((yield* store.review(scope, [{ id: live, action: "verify", basis: "test" }]))[0].result).toContain(
          "resolve legacy",
        )
        expect(yield* store.edit(live, { text: "attempt to edit old data" })).toBeUndefined()
        yield* store.remove(live)
        yield* store.clear(old)
        expect(yield* snapshot).toEqual(original)
        return original
      }),
    )
    .finally(() => first.dispose())
  const second = runtime(file)
  try {
    await second.runPromise(
      Effect.gen(function* () {
        const store = yield* MemoryStore.Service
        expect((yield* store.recovery(left)).frozen).toBe(true)
        const a = yield* store.scope(left)
        const b = yield* store.scope(right)
        expect(yield* store.resolveRecovery(left, { decision: "restore", ids: [live, deleted] })).toBe(false)
        expect(yield* store.list(a)).toEqual([])
        expect((yield* store.recovery(left)).frozen).toBe(true)
        expect(yield* store.resolveRecovery(left, { decision: "restore", ids: [live] })).toBe(true)
        expect(yield* store.resolveRecovery(left, { decision: "restore", ids: [live, live] })).toBe(true)
        const recovered = yield* store.list(a)
        expect(recovered).toHaveLength(1)
        expect(recovered[0]).toMatchObject({ text: "Useful old note", origin: "user", status: "verified" })
        expect(recovered[0].sessionID).toBeUndefined()
        expect(recovered[0].verification).toContain("source uncertain")
        expect((yield* store.recovery(right)).frozen).toBe(true)
        expect(yield* store.resolveRecovery(right, { decision: "restore", ids: [live] })).toBe(false)
        expect(yield* store.list(b)).toEqual([])
        expect(yield* store.resolveRecovery(right, { decision: "blank", ids: [] })).toBe(true)
        expect((yield* store.recovery(right)).state).toBe("blank")
        expect((yield* store.recovery(left)).automaticFrozen).toBe(true)
        expect((yield* store.recovery(right)).automaticFrozen).toBe(true)
        expect(yield* store.list(b)).toEqual([])
        for (const scope of [a, b]) {
          expect(yield* store.write({ ...content, scope, text: " DELETED   WORDING " })).toBeUndefined()
          expect(
            yield* store.observe({
              scope,
              kind: "practice",
              key: "original-deleted-key",
              text: "new wording of old fact",
              verification: "test",
              sessionID: SessionSchema.ID.make("ses_test"),
            }),
          ).toBeUndefined()
          expect(yield* store.write({ ...content, scope, text: "New model fact" })).toBeUndefined()
          expect(
            yield* store.write({ ...content, origin: "user", scope, text: "New allowed manual fact" }),
          ).toBeDefined()
        }
        expect(yield* store.edit(recovered[0].id, { text: "deleted wording" })).toBeUndefined()
        yield* store.remove(recovered[0].id)
        expect(
          yield* store.observe({
            scope: a,
            kind: "practice",
            key: "fact-live",
            text: "changed text of recovered fact",
            verification: "test",
            sessionID: SessionSchema.ID.make("ses_test"),
          }),
        ).toBeUndefined()
        expect(yield* store.resolveRecovery(left, { decision: "restore", ids: [live] })).toBe(true)
        expect((yield* store.list(a)).some((note) => note.id === recovered[0].id)).toBe(false)
        expect(yield* snapshot).toEqual(before)
      }),
    )
  } finally {
    await second.dispose()
  }
  const third = runtime(file)
  try {
    await third.runPromise(
      Effect.gen(function* () {
        const store = yield* MemoryStore.Service
        expect((yield* store.recovery(left)).state).toBe("restored")
        expect((yield* store.recovery(right)).state).toBe("blank")
        expect((yield* store.recovery(left)).automaticFrozen).toBe(true)
        expect((yield* store.recovery(right)).automaticFrozen).toBe(true)
        expect(
          yield* store.write({ ...content, scope: yield* store.scope(right), text: "deleted wording" }),
        ).toBeUndefined()
        expect(yield* snapshot).toEqual(before)
      }),
    )
  } finally {
    await third.dispose()
  }
})

test("no legacy data, Windows and repository/user scopes retain ordinary writes", async () => {
  for (const platform of ["linux", "win32"] as const) {
    const app = runtime(":memory:", platform)
    try {
      await app.runPromise(
        Effect.gen(function* () {
          const store = yield* MemoryStore.Service
          expect((yield* store.recovery(left)).state).toBe("none")
          for (const scope of [
            yield* store.scope(left),
            yield* store.scope({ ...left, project: Project.ID.make("repository") }),
            Memory.Scope.user,
          ]) {
            expect(yield* store.write({ ...content, scope, text: "Ordinary memory" })).toBeDefined()
          }
          expect(yield* store.resolveRecovery(left, { decision: "blank", ids: [] })).toBe(false)
        }),
      )
    } finally {
      await app.dispose()
    }
  }
})

test("real Recorder and memory_note tool cannot bypass pending legacy recovery", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* seed
      const database = yield* Database.Service
      const store = yield* MemoryStore.Service
      const events = yield* EventV2.Service
      const registry = yield* ToolRegistry.Service
      const catalog = yield* Catalog.Service
      const model = { id: ModelV2.ID.make("recovery-fixture"), providerID: ProviderV2.ID.make("recovery-fixture") }
      yield* catalog.transform((draft) => {
        draft.provider.update(model.providerID, (provider) => {
          provider.integrationID = undefined
        })
        draft.model.update(model.providerID, model.id, (entry) => {
          entry.enabled = true
          entry.capabilities.tools = true
        })
      })
      const target = SessionSchema.ID.make("ses_recovery_blocked")
      const control = SessionSchema.ID.make("ses_recovery_control")
      yield* database.db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make(left.directory), sandboxes: [] })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* database.db
        .insert(SessionTable)
        .values([
          {
            id: target,
            project_id: Project.ID.global,
            slug: target,
            directory: left.directory,
            title: "target",
            version: "test",
            model,
          },
          {
            id: control,
            project_id: Project.ID.global,
            slug: control,
            directory: "/Recovery/Other",
            title: "control",
            version: "test",
          },
        ])
        .run()
        .pipe(Effect.orDie)
      const captured = yield* registry.materialize()
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID: target,
        assistantMessageID: toolIdentity.assistantMessageID,
        agent: toolIdentity.agent,
        timestamp: DateTime.makeUnsafe(0),
        model,
      })
      yield* events.publish(SessionEvent.Tool.Called, {
        sessionID: target,
        assistantMessageID: toolIdentity.assistantMessageID,
        timestamp: DateTime.makeUnsafe(1),
        callID: "blocked-note",
        tool: "memory_note",
        input: { kind: "practice", text: "Do not bypass recovery" },
        provider: { executed: false },
      })
      const result = yield* captured.settle({
        sessionID: target,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "blocked-note",
          name: "memory_note",
          input: { kind: "practice", text: "Do not bypass recovery" },
        },
      })
      expect(JSON.stringify(result)).toContain("legacy recovery")
      for (const sessionID of [target, control]) {
        yield* events.publish(SessionEvent.Prompted, {
          timestamp: DateTime.makeUnsafe(1),
          sessionID,
          messageID: SessionMessage.ID.make(`msg_${sessionID}`),
          prompt: { text: "记住：提交前先跑类型检查", files: [], agents: [] },
          delivery: "steer",
        } as never)
      }
      const other = yield* store.scope({ ...left, directory: "/Recovery/Other" })
      for (let attempt = 0; attempt < 50 && (yield* store.list(other)).length === 0; attempt++)
        yield* Effect.sleep("10 millis")
      expect(yield* store.list(other)).toHaveLength(1)
      expect(yield* store.list(yield* store.scope(left))).toEqual([])
      expect((yield* store.recovery(left)).frozen).toBe(true)
    }).pipe(
      Effect.provide(
        AppNodeBuilder.build(
          LayerNode.group([
            Database.node,
            EventV2.node,
            MemoryRecorder.node,
            MemoryStore.node,
            MemoryTool.node,
            SessionProjector.node,
            Catalog.node,
            ToolRegistry.node,
          ]),
          [
            [
              ModelMemoryProfile.node,
              Layer.succeed(
                ModelMemoryProfile.Service,
                ModelMemoryProfile.Service.of({
                  memoryNote: (entry, variant) =>
                    entry.providerID === "recovery-fixture" && entry.id === "recovery-fixture" && variant === undefined
                      ? true
                      : undefined,
                }),
              ),
            ],
            [MemoryStore.node, MemoryStore.layerWith("linux")],
            [
              Location.node,
              Layer.succeed(Location.Service, location({ directory: AbsolutePath.make(left.directory) })),
            ],
            [Config.node, Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed([]) }))],
          ],
        ),
      ),
      Effect.scoped,
    ),
  )
})
