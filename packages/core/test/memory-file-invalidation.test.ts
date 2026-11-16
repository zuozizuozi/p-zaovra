import { expect, test } from "bun:test"
import path from "node:path"
import { eq } from "drizzle-orm"
import { Effect, Layer, ManagedRuntime } from "effect"
import { Memory } from "@zaovra-ai/schema/memory"
import { Database } from "../src/database/database"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { Watcher } from "../src/filesystem/watcher"
import { WatcherSignal } from "../src/filesystem/watcher-signal"
import { Location } from "../src/location"
import { MemoryContext } from "../src/memory/context"
import { MemoryFileInvalidation } from "../src/memory/file-invalidation"
import { MemoryFileEvidence } from "../src/memory/file-evidence"
import { MemoryPages } from "../src/memory/pages"
import { MemoryStore } from "../src/memory/store"
import { MemoryNoteTable, MemoryRecoveryTable } from "../src/memory/sql"
import { Project } from "../src/project"
import { AbsolutePath } from "../src/schema"
import { SessionSchema } from "../src/session/schema"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

const directory = path.resolve("/invalidation-fixture")
const project = Project.ID.make("file-invalidation-project")
const scope = Memory.Scope.make(project)
const location = Location.Service.of({
  directory: AbsolutePath.make(directory),
  project: { id: project, directory: AbsolutePath.make(directory) },
})
const nodes = LayerNode.group([MemoryStore.node, Database.node, WatcherSignal.node, MemoryPages.node])
const it = testEffect(AppNodeBuilder.build(nodes))
const service = MemoryFileInvalidation.layer.pipe(Layer.provide(Layer.succeed(Location.Service, location)))
const files = [
  {
    path: "src/config.ts",
    directory,
    identity: "storage-fixture-only",
    digest: "a".repeat(64),
    bytes: 12,
    sessionID: SessionSchema.ID.make("ses_file_invalidation"),
    seq: 1,
  },
]
const raw = (id: Memory.ID) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    return (yield* database.db
      .select()
      .from(MemoryNoteTable)
      .where(eq(MemoryNoteTable.id, id))
      .get()
      .pipe(Effect.orDie))!
  })
const setup = Effect.gen(function* () {
  const store = yield* MemoryStore.Service
  const database = yield* Database.Service
  const signals = yield* WatcherSignal.Service
  const note = (yield* store.write({
    scope,
    text: "Keep original user wording",
    kind: "preference",
    status: "verified",
    origin: "user",
  }))!
  yield* store.bindFiles({ id: note.id, scope, files, expectedRevision: 0 })
  yield* store.checkFiles({
    id: note.id,
    scope,
    expectedRevision: 1,
    results: [{ path: files[0].path, state: "unchanged" }],
  })
  expect((yield* raw(note.id)).files).toMatchObject({ state: "current" })
  return { store, database, signals, note: (yield* store.get(note.id))! }
})

it.effect("startup persists unknown before service use; no current enters a new index or page sources", () =>
  Effect.gen(function* () {
    const h = yield* setup
    expect(h.note.files).toMatchObject({ state: "unknown" })
    expect(MemoryContext.lines([h.note])).toEqual([])
    const pages = yield* MemoryPages.Service
    expect(yield* pages.sources(scope)).toEqual([])
    yield* Effect.gen(function* () {
      expect((yield* raw(h.note.id)).files).toMatchObject({ state: "unknown" })
      expect((yield* raw(h.note.id)).file_revision).toBe(3)
      expect((yield* h.store.get(h.note.id))!.text).toBe(h.note.text)
    }).pipe(Effect.provide(service), Effect.scoped)
  }),
)

for (const event of ["create", "update", "delete"] as const)
  it.effect(`native ${event} hint invalidates exact leaf and defeats an in-flight check without claiming missing`, () =>
    Effect.gen(function* () {
      const h = yield* setup
      yield* Effect.gen(function* () {
        const held = (yield* h.store.get(h.note.id))!
        // Invoke the same adapter used by the native watcher, and drain its actual service effect.
        const pending: Effect.Effect<void>[] = []
        const delivered: string[] = []
        Watcher.subscriptionCallback(
          (file) => {
            pending.push(h.signals.publish(file))
          },
          (event) => {
            delivered.push(event.path)
          },
        )(null, [{ type: event, path: path.join(directory, files[0].path) }])
        yield* Effect.all(pending)
        expect(delivered).toEqual([path.join(directory, files[0].path)])
        expect((yield* raw(h.note.id)).file_revision).toBe(held.fileRevision! + 1)
        expect((yield* raw(h.note.id)).files).toMatchObject({ state: "unknown" })
        expect(
          yield* h.store.checkFiles({
            id: held.id,
            scope,
            expectedRevision: held.fileRevision!,
            results: [{ path: files[0].path, state: "unchanged" }],
          }),
        ).toBe(false)
        expect((yield* h.store.get(held.id))!.status).toBe("verified")
      }).pipe(Effect.provide(service), Effect.scoped)
    }),
  )

it.effect("ancestor changes apply; sibling paths, other roots/scopes and relative hints do not", () =>
  Effect.gen(function* () {
    const h = yield* setup
    const before = yield* raw(h.note.id)
    for (const file of [path.join(directory, "src-other"), path.join(directory, "src/config.ts.bak"), "src/config.ts"])
      yield* h.store.invalidateFiles({ scope, directory, path: file })
    yield* h.store.invalidateFiles({ scope: Memory.Scope.user, directory })
    yield* h.store.invalidateFiles({ scope, directory: path.resolve("/other") })
    expect(yield* raw(h.note.id)).toEqual(before)
    yield* h.store.invalidateFiles({ scope, directory, path: path.join(directory, "src") })
    expect((yield* raw(h.note.id)).file_revision).toBe(before.file_revision + 1)
    yield* h.store.invalidateFiles({ scope, directory, path: path.dirname(directory) })
    expect((yield* raw(h.note.id)).file_revision).toBe(before.file_revision + 2)
  }),
)

it.effect("native errors without updates and HEAD notifications revoke all; disposal removes listener", () =>
  Effect.gen(function* () {
    const h = yield* setup
    yield* Effect.gen(function* () {
      const before = (yield* raw(h.note.id)).file_revision
      const pending: Effect.Effect<void>[] = []
      const callback = Watcher.subscriptionCallback(
        (file) => {
          pending.push(h.signals.publish(file))
        },
        () => {
          throw new Error("error must not publish a success update")
        },
      )
      callback(new Error("native watch lost"), [])
      yield* Effect.all(pending)
      expect((yield* raw(h.note.id)).file_revision).toBe(before + 1)
      pending.length = 0
      Watcher.subscriptionCallback(
        (file) => {
          pending.push(h.signals.publish(file))
        },
        () => {},
        true,
      )(null, [{ type: "update", path: path.resolve("/git-common/HEAD") }])
      yield* Effect.all(pending)
      expect((yield* raw(h.note.id)).file_revision).toBe(before + 2)
      yield* h.signals.publish()
      expect((yield* raw(h.note.id)).file_revision).toBe(before + 3)
    }).pipe(Effect.provide(service), Effect.scoped)
    const disposed = yield* raw(h.note.id)
    yield* h.signals.publish()
    expect(yield* raw(h.note.id)).toEqual(disposed)
  }),
)

for (const state of ["changed", "missing"] as const)
  it.effect(
    `${state} remains sticky; event hints preserve user text/status and silence cannot leave current trusted`,
    () =>
      Effect.gen(function* () {
        const h = yield* setup
        yield* h.store.checkFiles({
          id: h.note.id,
          scope,
          expectedRevision: h.note.fileRevision!,
          results: [{ path: files[0].path, state }],
        })
        const before = yield* raw(h.note.id)
        yield* h.store.silence(scope, true)
        yield* h.store.invalidateFiles({ scope, directory })
        const after = yield* raw(h.note.id)
        expect(after.files).toEqual(before.files)
        expect([after.text, after.status, after.origin, after.time_updated]).toEqual([
          before.text,
          before.status,
          before.origin,
          before.time_updated,
        ])
        expect(after.file_revision).toBe(before.file_revision + 1)
      }),
  )

it.effect("unknown versions and deleted rows remain byte-for-byte unchanged", () =>
  Effect.gen(function* () {
    const h = yield* setup
    yield* h.database.db
      .update(MemoryNoteTable)
      .set({ files: { version: 99, opaque: "keep" } })
      .where(eq(MemoryNoteTable.id, h.note.id))
      .run()
      .pipe(Effect.orDie)
    const future = yield* raw(h.note.id)
    yield* h.store.invalidateFiles({ scope, directory })
    expect(yield* raw(h.note.id)).toEqual(future)
    yield* h.store.remove(h.note.id)
    const deleted = yield* raw(h.note.id)
    yield* h.store.invalidateFiles({ scope, directory })
    expect(yield* raw(h.note.id)).toEqual(deleted)
    expect(yield* h.store.get(h.note.id)).toBeUndefined()
  }),
)

it.effect("legacy, recovery-pending and automatic-frozen buckets are not rewritten", () =>
  Effect.gen(function* () {
    const h = yield* setup
    const old = Memory.Scope.make("dir_" + "a".repeat(24))
    const pending = Memory.Scope.make("dir_posix_v2_pending")
    const automatic = Memory.Scope.make("automatic-frozen")
    yield* h.database.db
      .insert(MemoryRecoveryTable)
      .values([
        { scope: pending, legacy_scope: old, directory: "/frozen" },
        { scope: automatic, legacy_scope: old, directory: "/automatic", state: "blank" },
      ])
      .run()
      .pipe(Effect.orDie)
    yield* h.database.db
      .insert(MemoryNoteTable)
      .values({
        id: Memory.ID.make("mem_old_tombstone"),
        scope: old,
        key: "opaque-key",
        text: "",
        kind: "practice",
        origin: "model",
        status: "stale",
        time_observed: 1,
        time_deleted: 1,
      })
      .run()
      .pipe(Effect.orDie)
    for (const bucket of [old, pending, automatic]) {
      yield* h.database.db
        .update(MemoryNoteTable)
        .set({ scope: bucket, files: { version: 1, state: "current", files: [{ ...files[0], directory: "/frozen" }] } })
        .where(eq(MemoryNoteTable.id, h.note.id))
        .run()
        .pipe(Effect.orDie)
      const before = yield* raw(h.note.id)
      yield* Effect.gen(function* () {
        const store = yield* MemoryStore.Service
        yield* store.invalidateFiles({ scope: bucket, directory: "/frozen" })
        expect((yield* store.get(h.note.id))!.files).toMatchObject({ state: "unknown" })
      }).pipe(Effect.provide(MemoryStore.layerWith("linux")))
      expect(yield* raw(h.note.id)).toEqual(before)
    }
  }),
)

test("persistent current written by another connection and after reopen never becomes consumer authority", async () => {
  await using temp = await tmpdir()
  const runtime = () =>
    ManagedRuntime.make(
      AppNodeBuilder.build(nodes, [[Database.node, Database.layerFromPath(path.join(temp.path, "invalidation.db"))]]),
    )
  const first = runtime()
  const h = await first.runPromise(setup)
  await first.dispose()
  const reader = runtime()
  const writer = runtime()
  try {
    await reader.runPromise(
      Effect.gen(function* () {
        const store = yield* MemoryStore.Service
        expect((yield* store.get(h.note.id))!.files).toMatchObject({ state: "unknown" })
        yield* store.invalidateFiles({ scope, directory })
      }),
    )
    await writer.runPromise(
      Effect.gen(function* () {
        const store = yield* MemoryStore.Service
        const note = (yield* store.get(h.note.id))!
        expect(
          yield* store.checkFiles({
            id: note.id,
            scope,
            expectedRevision: note.fileRevision!,
            results: [{ path: files[0].path, state: "unchanged" }],
          }),
        ).toBe(true)
        expect((yield* raw(note.id)).files).toMatchObject({ state: "current" })
      }),
    )
    await reader.runPromise(
      Effect.gen(function* () {
        const store = yield* MemoryStore.Service
        expect((yield* store.get(h.note.id))!.files).toMatchObject({ state: "unknown" })
        expect(MemoryContext.lines(yield* store.list(scope))).toEqual([])
      }),
    )
  } finally {
    await reader.dispose()
    await writer.dispose()
  }
})

test("lexical matching preserves POSIX case/backslashes and handles Windows case without filesystem IO", () => {
  const links = { version: 1 as const, files: [{ ...files[0], directory: "/Root" }], state: "current" as const }
  expect(MemoryFileEvidence.affected(links, { directory: "/root" }, "linux")).toBe(false)
  expect(MemoryFileEvidence.affected(links, { directory: "/Root", path: "/Root/src" }, "linux")).toBe(true)
  expect(MemoryFileEvidence.affected(links, { directory: "/Root", path: "/Root/src\\config.ts" }, "linux")).toBe(false)
  expect(
    MemoryFileEvidence.affected(
      { ...links, files: [{ ...files[0], directory: "C:\\Root" }] },
      { directory: "c:/ROOT", path: "C:/Root/SRC" },
      "win32",
    ),
  ).toBe(true)
})
