import { expect } from "bun:test"
import { Effect } from "effect"
import { eq, sql } from "drizzle-orm"
import { Database } from "@zaovra-ai/core/database/database"
import { AppNodeBuilder } from "@zaovra-ai/core/effect/app-node-builder"
import { LayerNode } from "@zaovra-ai/core/effect/layer-node"
import { MemoryStore } from "@zaovra-ai/core/memory/store"
import { MemoryNoteTable } from "@zaovra-ai/core/memory/sql"
import { SessionSchema } from "@zaovra-ai/core/session/schema"
import { Hash } from "@zaovra-ai/core/util/hash"
import { Memory } from "@zaovra-ai/schema/memory"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, MemoryStore.node])))
const content = { kind: "preference" as const, origin: "model" as const, status: "unverified" as const }

for (const scope of [Memory.Scope.user, Memory.Scope.make("deleted-project")]) {
  for (const source of ["program", "model"] as const)
    for (const action of ["remove", "clear"] as const)
      it.live(`memory deletion keeps original and edited text suppressed: ${scope}/${source}/${action}`, () =>
        Effect.gen(function* () {
          const store = yield* MemoryStore.Service
          const database = yield* Database.Service
          const observation = {
            scope,
            kind: "preference" as const,
            key: "said:blue",
            text: "Only blue",
            verification: MemoryStore.said,
            sessionID: SessionSchema.ID.make("ses_deletion"),
            settled: true,
          }
          const original = (
            source === "program"
              ? yield* store.observe(observation)
              : yield* store.write({ ...content, scope, text: observation.text })
          )!
          yield* store.edit(original.id, { text: "Only green" })
          if (action === "remove") yield* store.remove(original.id)
          if (action === "clear") yield* store.clear(scope)
          // Repeated deletion must not replace the saved alias with the now-empty text.
          yield* store.remove(original.id)
          yield* store.clear(scope)
          expect(yield* store.write({ ...content, scope, text: "  ONLY   GREEN  " })).toBeUndefined()
          expect(yield* store.observe({ ...observation, key: "another-fact", text: "only green" })).toBeUndefined()
          if (source === "program") expect(yield* store.observe(observation)).toBeUndefined()
          if (source === "model")
            expect(yield* store.write({ ...content, scope, text: observation.text })).toBeUndefined()
          expect(yield* store.list(scope)).toEqual([])
          expect((yield* store.search({ scope, query: "green" })).notes).toEqual([])
          const rows = yield* database.db.select().from(MemoryNoteTable).all().pipe(Effect.orDie)
          expect(rows.length).toBe(2)
          expect(
            rows.every(
              (row) =>
                row.text === "" && row.verification === null && row.session_id === null && row.time_deleted !== null,
            ),
          ).toBe(true)
          expect(
            yield* store.write({ ...content, scope: Memory.Scope.make("other-scope"), text: "Only green" }),
          ).toBeDefined()
        }),
      )

  it.live(`memory deletion preserves existing same-text live notes: ${scope}`, () =>
    Effect.gen(function* () {
      const store = yield* MemoryStore.Service
      const original = (yield* store.write({ ...content, scope, text: "old wording" }))!
      const live = (yield* store.write({ ...content, scope, text: "current wording" }))!
      yield* store.edit(original.id, { text: live.text })
      yield* store.remove(original.id)
      expect(yield* store.get(live.id)).toEqual(live)
      expect(yield* store.list(scope)).toEqual([live])
      expect(yield* store.write({ ...content, scope, text: live.text })).toBeUndefined()
      // The distinct live note remains editable; deletion aliases are not note rows in the UI.
      expect((yield* store.edit(live.id, { text: "still mine" }))?.text).toBe("still mine")
      yield* store.clear(scope)
      expect(yield* store.write({ ...content, scope, text: "still mine" })).toBeUndefined()
      expect(yield* store.write({ ...content, scope, text: "current wording" })).toBeUndefined()
    }),
  )
}

it.live("memory deletion covers model merge rewrites without breaking normal merge", () =>
  Effect.gen(function* () {
    const store = yield* MemoryStore.Service
    const scope = Memory.Scope.make("merge-delete")
    const source = (yield* store.write({ ...content, scope, text: "source fact" }))!
    const target = (yield* store.write({ ...content, scope, text: "target fact" }))!
    expect(
      (yield* store.review(scope, [
        { id: source.id, action: "merge", into: target.id, text: "combined fact", basis: "same observation" },
      ]))[0].result,
    ).toContain("merged into")
    expect((yield* store.get(target.id))?.text).toBe("combined fact")
    yield* store.remove(target.id)
    for (const text of ["source fact", "target fact", "combined fact"])
      expect(yield* store.write({ ...content, scope, text })).toBeUndefined()
  }),
)

it.live("legacy blank tombstones keep their keys without guessing missing edited text", () =>
  Effect.gen(function* () {
    const store = yield* MemoryStore.Service
    const database = yield* Database.Service
    const scope = Memory.Scope.make("legacy-delete")
    yield* database.db
      .insert(MemoryNoteTable)
      .values({
        id: Memory.ID.create(),
        scope,
        key: `text:${Hash.fast("old text")}`,
        kind: "preference",
        text: "",
        origin: "model",
        status: "unverified",
        time_observed: 1,
        time_deleted: 1,
      })
      .run()
      .pipe(Effect.orDie)
    yield* store.clear(scope)
    expect(yield* store.write({ ...content, scope, text: "old text" })).toBeUndefined()
    expect(yield* store.write({ ...content, scope, text: "unknowable previous edit" })).toBeDefined()
  }),
)

it.live("model merge cannot bypass a deleted-text alias or discard its source on refusal", () =>
  Effect.gen(function* () {
    const store = yield* MemoryStore.Service
    const scope = Memory.Scope.make("merge-alias")
    const deleted = (yield* store.write({ ...content, scope, text: "obsolete" }))!
    yield* store.edit(deleted.id, { text: "Do not remember" })
    yield* store.remove(deleted.id)
    const source = (yield* store.write({ ...content, scope, text: "source" }))!
    const target = (yield* store.write({ ...content, scope, text: "target" }))!
    const result = yield* store.review(scope, [
      { id: source.id, action: "merge", into: target.id, text: "DO NOT   REMEMBER", basis: "model rewording" },
    ])
    expect(result[0].result).toBe("refused: wording was deleted by the user")
    expect(yield* store.get(source.id)).toEqual(source)
    expect(yield* store.get(target.id)).toEqual(target)
  }),
)

it.live("concurrent deletion and recording keep suppression after both settle", () =>
  Effect.gen(function* () {
    const store = yield* MemoryStore.Service
    for (const source of ["write", "observe"] as const) {
      const scope = Memory.Scope.make(`concurrent-${source}`)
      const original = (yield* store.write({ ...content, scope, text: "original" }))!
      yield* store.edit(original.id, { text: "deleted wording" })
      const observation = {
        scope,
        kind: "preference" as const,
        key: "new-fact",
        text: "deleted wording",
        verification: "observed",
        sessionID: SessionSchema.ID.make("ses_concurrent"),
      }
      const results = yield* Effect.all(
        [
          store.remove(original.id),
          source === "write" ? store.write({ ...content, scope, text: observation.text }) : store.observe(observation),
        ],
        { concurrency: "unbounded" },
      )
      expect(yield* store.get(original.id)).toBeUndefined()
      expect(yield* store.write({ ...content, scope, text: observation.text })).toBeUndefined()
      expect(yield* store.observe(observation)).toBeUndefined()
      // A distinct note committed before deletion is not silently removed by the alias.
      expect(yield* store.list(scope)).toEqual(results[1] ? [results[1]] : [])
    }
  }),
)

it.live("memory deletion aliases roll back if deleting the original fails", () =>
  Effect.gen(function* () {
    const store = yield* MemoryStore.Service
    const database = yield* Database.Service
    const scope = Memory.Scope.make("rollback-delete")
    const original = (yield* store.write({ ...content, scope, text: "before edit" }))!
    yield* store.edit(original.id, { text: "after edit" })
    yield* database.db
      .run(
        sql`CREATE TRIGGER reject_memory_delete BEFORE UPDATE OF time_deleted ON memory_note BEGIN SELECT RAISE(ABORT, 'test deletion failure'); END`,
      )
      .pipe(Effect.orDie)
    expect((yield* store.remove(original.id).pipe(Effect.exit))._tag).toBe("Failure")
    const rows = yield* database.db
      .select()
      .from(MemoryNoteTable)
      .where(eq(MemoryNoteTable.scope, scope))
      .all()
      .pipe(Effect.orDie)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: original.id, text: "after edit", time_deleted: null })
    yield* database.db.run(sql`DROP TRIGGER reject_memory_delete`).pipe(Effect.orDie)
    expect(yield* store.write({ ...content, scope, text: "after edit" })).toBeDefined()
    yield* store.clear(scope)
    expect(yield* store.write({ ...content, scope, text: "after edit" })).toBeUndefined()
  }),
)
