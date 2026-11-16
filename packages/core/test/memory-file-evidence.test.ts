import { expect, test } from "bun:test"
import path from "node:path"
import { eq } from "drizzle-orm"
import { Effect, ManagedRuntime } from "effect"
import { Memory } from "@zaovra-ai/schema/memory"
import { Database } from "../src/database/database"
import { DatabaseMigration } from "../src/database/migration"
import { migrations } from "../src/database/migration.gen"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { MemoryFileEvidence } from "../src/memory/file-evidence"
import { MemoryStore } from "../src/memory/store"
import { MemoryNoteTable } from "../src/memory/sql"
import { SessionSchema } from "../src/session/schema"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

const nodes = LayerNode.group([MemoryStore.node, Database.node])
const it = testEffect(AppNodeBuilder.build(nodes))
const scope = Memory.Scope.make("file-evidence-project")
// Storage fixtures only: these are NOT receipts from a production read/verification.
const files = [
  {
    path: "src/example.ts",
    directory: "/fixture",
    identity: "fixture-inode",
    digest: "a".repeat(64),
    bytes: 12,
    sessionID: SessionSchema.ID.make("ses_file_fixture"),
    seq: 1,
  },
]
const setup = Effect.gen(function* () {
  const store = yield* MemoryStore.Service
  const database = yield* Database.Service
  const note = yield* store.write({
    scope,
    kind: "practice",
    text: "Use the isolated fixture",
    origin: "model",
    status: "verified",
  })
  if (!note) throw new Error("fixture note missing")
  return { store, database, note }
})
const check = (
  store: MemoryStore.Interface,
  note: Memory.Note,
  state: "unchanged" | "unknown" | "changed" | "missing",
) =>
  store.checkFiles({
    id: note.id,
    scope: note.scope,
    expectedRevision: note.fileRevision ?? 0,
    results: [{ path: files[0].path, state }],
  })

it.effect("legacy notes stay unassociated; a binding starts unknown and never promotes verification", () =>
  Effect.gen(function* () {
    const h = yield* setup
    expect(h.note.files).toBeUndefined()
    expect(h.note.fileRevision).toBe(0)
    expect(MemoryFileEvidence.usable(h.note)).toBe(true)
    expect(yield* h.store.bindFiles({ id: h.note.id, scope, expectedRevision: 0, files })).toBe(true)
    const bound = (yield* h.store.get(h.note.id))!
    expect(bound.files).toMatchObject({ version: 1, state: "unknown", files })
    expect(bound.status).toBe(h.note.status)
    expect(MemoryFileEvidence.usable(bound)).toBe(false)
    expect(yield* check(h.store, bound, "unchanged")).toBe(true)
    const current = (yield* h.store.get(h.note.id))!
    expect(
      (yield* h.database.db
        .select()
        .from(MemoryNoteTable)
        .where(eq(MemoryNoteTable.id, current.id))
        .get()
        .pipe(Effect.orDie))?.files,
    ).toMatchObject({ state: "current" })
    expect(current.files).toMatchObject({ state: "unknown" })
    expect(current.status).toBe(h.note.status)
    expect(MemoryFileEvidence.usable(current)).toBe(false)
  }),
)

for (const state of ["unknown", "changed", "missing"] as const)
  it.effect(`file ${state} keeps original evidence and changes status only on confirmed invalidation`, () =>
    Effect.gen(function* () {
      const h = yield* setup
      yield* h.store.bindFiles({ id: h.note.id, scope, expectedRevision: 0, files })
      expect(yield* check(h.store, (yield* h.store.get(h.note.id))!, state)).toBe(true)
      const changed = (yield* h.store.get(h.note.id))!
      expect(changed.status).toBe(state === "unknown" ? "verified" : "stale")
      expect(changed.files).toMatchObject({ state, files })
      if (state === "unknown") return
      expect(yield* check(h.store, changed, "unchanged")).toBe(true)
      const still = (yield* h.store.get(h.note.id))!
      expect(still.status).toBe("stale")
      expect(still.files).toMatchObject({ state, files })
      expect(
        yield* h.store.bindFiles({
          id: still.id,
          scope,
          expectedRevision: still.fileRevision!,
          files: [{ ...files[0], digest: "b".repeat(64) }],
        }),
      ).toBe(false)
      expect(
        (yield* h.store.review(scope, [{ id: still.id, action: "verify", basis: "model says fixed" }]))[0].result,
      ).toContain("refused")
    }),
  )

it.effect("user writing and confirmed user quotes keep status, origin and text, with an independent alert", () =>
  Effect.gen(function* () {
    const h = yield* setup
    const manual = (yield* h.store.edit(h.note.id, { text: "User instruction" }))!
    const quote = (yield* h.store.observe({
      scope,
      kind: "preference",
      key: "said:fixture",
      text: "User original quote",
      verification: MemoryStore.said,
      settled: true,
      sessionID: files[0].sessionID,
    }))!
    for (const note of [manual, quote]) {
      yield* h.store.bindFiles({ id: note.id, scope, expectedRevision: note.fileRevision ?? 0, files })
      yield* check(h.store, (yield* h.store.get(note.id))!, "changed")
      const changed = (yield* h.store.get(note.id))!
      expect([changed.text, changed.origin, changed.status]).toEqual([note.text, note.origin, note.status])
      expect(changed.files).toMatchObject({ state: "changed" })
      expect(MemoryFileEvidence.usable(changed)).toBe(false)
    }
  }),
)

it.effect("scope, revision, complete coverage and unknown versions are checked without interpreting paths", () =>
  Effect.gen(function* () {
    const h = yield* setup
    expect(yield* h.store.bindFiles({ id: h.note.id, scope: Memory.Scope.user, expectedRevision: 0, files })).toBe(
      false,
    )
    for (const path of ["../secret", "/absolute", "C:/secret", "a\\b", "a//b", "a/./b"])
      expect(
        yield* h.store.bindFiles({ id: h.note.id, scope, expectedRevision: 0, files: [{ ...files[0], path }] }),
      ).toBe(false)
    expect(yield* h.store.bindFiles({ id: h.note.id, scope, expectedRevision: 0, files: [...files, ...files] })).toBe(
      false,
    )
    expect(yield* h.store.bindFiles({ id: h.note.id, scope, expectedRevision: 0, files })).toBe(true)
    expect(yield* h.store.checkFiles({ id: h.note.id, scope, expectedRevision: 1, results: [] })).toBe(false)
    expect(
      yield* h.store.checkFiles({
        id: h.note.id,
        scope,
        expectedRevision: 1,
        results: [{ path: "other", state: "changed" }],
      }),
    ).toBe(false)
    const before = (yield* h.store.get(h.note.id))!
    yield* h.store.edit(h.note.id, { text: "Concurrent user edit" })
    expect(yield* check(h.store, before, "changed")).toBe(false)
    const future = { version: 99, files: [{ path: "do-not-read" }] }
    yield* h.database.db
      .update(MemoryNoteTable)
      .set({ files: future })
      .where(eq(MemoryNoteTable.id, h.note.id))
      .run()
      .pipe(Effect.orDie)
    const unknown = (yield* h.store.get(h.note.id))!
    expect(unknown.files).toEqual(future)
    expect(MemoryFileEvidence.usable(unknown)).toBe(false)
    expect(yield* check(h.store, unknown, "changed")).toBe(false)
    expect(yield* h.store.bindFiles({ id: unknown.id, scope, expectedRevision: unknown.fileRevision!, files })).toBe(
      false,
    )
  }),
)

it.effect("delete and clear erase file provenance and reject late checks without reviving tombstones", () =>
  Effect.gen(function* () {
    const h = yield* setup
    yield* h.store.bindFiles({ id: h.note.id, scope, expectedRevision: 0, files })
    const before = (yield* h.store.get(h.note.id))!
    yield* h.store.remove(h.note.id)
    expect(yield* check(h.store, before, "changed")).toBe(false)
    expect(yield* h.store.get(h.note.id)).toBeUndefined()
    const row = yield* h.database.db
      .select()
      .from(MemoryNoteTable)
      .where(eq(MemoryNoteTable.id, h.note.id))
      .get()
      .pipe(Effect.orDie)
    expect(row).toMatchObject({ files: null, text: "", session_id: null, seq: null })
    expect(yield* h.store.write({ ...h.note })).toBeUndefined()
    const other = (yield* h.store.write({
      scope,
      kind: "practice",
      text: "other",
      origin: "model",
      status: "unverified",
    }))!
    yield* h.store.bindFiles({ id: other.id, scope, expectedRevision: 0, files })
    yield* h.store.clear(scope)
    expect(
      (yield* h.database.db
        .select()
        .from(MemoryNoteTable)
        .where(eq(MemoryNoteTable.id, other.id))
        .get()
        .pipe(Effect.orDie))?.files,
    ).toBeNull()
  }),
)

it.effect("ordinary observations cannot promote a stale practice in another session", () =>
  Effect.gen(function* () {
    const h = yield* setup
    const input = {
      scope,
      key: "check:stale",
      kind: "practice" as const,
      text: "A previous command succeeded",
      verification: "exit 0",
      sessionID: files[0].sessionID,
    }
    const note = (yield* h.store.observe(input))!
    yield* h.store.bindFiles({ id: note.id, scope, expectedRevision: 0, files })
    yield* check(h.store, (yield* h.store.get(note.id))!, "changed")
    const again = (yield* h.store.observe({
      ...input,
      sessionID: SessionSchema.ID.make("ses_another"),
      settled: true,
    }))!
    expect(again.status).toBe("stale")
    expect(again.files).toMatchObject({ state: "changed", files })
  }),
)

it.effect("only one competing revision wins; ordinary review and silence invalidate or block stale work", () =>
  Effect.gen(function* () {
    const h = yield* setup
    const input = { id: h.note.id, scope, expectedRevision: 0, files }
    expect(
      (yield* Effect.all([h.store.bindFiles(input), h.store.bindFiles(input)], { concurrency: 2 })).filter(Boolean),
    ).toHaveLength(1)
    const held = (yield* h.store.get(h.note.id))!
    yield* check(h.store, held, "unchanged")
    const current = (yield* h.store.get(h.note.id))!
    yield* h.store.review(scope, [{ id: current.id, action: "stale", basis: "Independent review" }])
    expect(yield* check(h.store, current, "unknown")).toBe(false)
    yield* h.store.silence(scope, true)
    expect(yield* check(h.store, (yield* h.store.get(current.id))!, "missing")).toBe(false)
  }),
)

test("real SQLite reopen and separate connections preserve binding and reject a superseded check", async () => {
  await using temp = await tmpdir()
  const runtime = () =>
    ManagedRuntime.make(
      AppNodeBuilder.build(nodes, [[Database.node, Database.layerFromPath(path.join(temp.path, "files.db"))]]),
    )
  const first = runtime()
  const note = await first
    .runPromise(
      Effect.gen(function* () {
        const h = yield* setup
        yield* h.store.bindFiles({ id: h.note.id, scope, expectedRevision: 0, files })
        return (yield* h.store.get(h.note.id))!
      }),
    )
    .finally(() => first.dispose())
  const second = runtime()
  const third = runtime()
  try {
    expect(
      await second.runPromise(
        Effect.gen(function* () {
          const store = yield* MemoryStore.Service
          return yield* store.get(note.id)
        }),
      ),
    ).toEqual(note)
    await third.runPromise(
      Effect.gen(function* () {
        const store = yield* MemoryStore.Service
        yield* store.edit(note.id, { text: "other connection" })
      }),
    )
    expect(
      await second.runPromise(
        Effect.gen(function* () {
          const store = yield* MemoryStore.Service
          return yield* check(store, note, "missing")
        }),
      ),
    ).toBe(false)
  } finally {
    await second.dispose()
    await third.dispose()
  }
})

it.effect("incremental migration preserves a legacy note and is idempotent", () =>
  Effect.gen(function* () {
    const h = yield* setup
    // The migration is generated only after the controller returns the window.
    const migration = migrations.find((entry) => entry.id.endsWith("memory-file-links"))
    if (!migration) throw new Error("Generate the approved memory-file-links migration before validation")
    yield* h.database.db.run("ALTER TABLE memory_note DROP COLUMN files").pipe(Effect.orDie)
    yield* h.database.db.run("ALTER TABLE memory_note DROP COLUMN file_revision").pipe(Effect.orDie)
    yield* h.database.db.run(`DELETE FROM migration WHERE id = '${migration.id}'`).pipe(Effect.orDie)
    yield* DatabaseMigration.applyOnly(h.database.db, [migration]).pipe(Effect.orDie)
    expect(yield* h.store.get(h.note.id)).toEqual(h.note)
    yield* DatabaseMigration.applyOnly(h.database.db, [migration]).pipe(Effect.orDie)
    expect(yield* h.store.get(h.note.id)).toEqual(h.note)
  }),
)
