import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@zaovra-ai/effect-drizzle-sqlite"
import { DatabaseMigration } from "@zaovra-ai/core/database/migration"
import memoryMigration from "@zaovra-ai/core/database/migration/20261113202309_agent-memory"
import { Effect } from "effect"
import { sql } from "drizzle-orm"

describe("agent memory migration", () => {
  test("upgrades existing data once and preserves notes on a second startup", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* EffectDrizzleSqlite.makeWithDefaults()
        yield* db.run(sql`CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT NOT NULL)`)
        yield* db.run(sql`INSERT INTO session VALUES ('existing', 'Keep this conversation')`)
        yield* DatabaseMigration.applyOnly(db, [memoryMigration])
        yield* db.run(sql`INSERT INTO memory_note
          (id, scope, key, kind, text, origin, status, time_observed, time_created, time_updated)
          VALUES ('note', 'project', 'test-command', 'practice', 'bun test', 'user', 'verified', 1, 1, 1)`)
        yield* DatabaseMigration.applyOnly(db, [memoryMigration])
        expect(yield* db.all(sql`SELECT * FROM session`)).toEqual([{ id: "existing", title: "Keep this conversation" }])
        expect(yield* db.get(sql`SELECT text, hits FROM memory_note WHERE id = 'note'`)).toEqual({
          text: "bun test",
          hits: 1,
        })
        expect(yield* db.get(sql`SELECT count(*) AS count FROM migration WHERE id = ${memoryMigration.id}`)).toEqual({
          count: 1,
        })
        expect(
          yield* db.all(
            sql`SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'memory_note_scope_%' ORDER BY name`,
          ),
        ).toEqual([{ name: "memory_note_scope_key_idx" }, { name: "memory_note_scope_time_updated_idx" }])
      }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
    )
  })

  test("rolls back a partially applied migration and allows a clean retry", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* EffectDrizzleSqlite.makeWithDefaults()
        yield* db.run(sql`CREATE TABLE sentinel (value TEXT)`)
        yield* db.run(sql`INSERT INTO sentinel VALUES ('untouched')`)
        yield* db.run(sql`CREATE INDEX memory_note_scope_key_idx ON sentinel(value)`)
        const failed = yield* Effect.exit(DatabaseMigration.applyOnly(db, [memoryMigration]))
        expect(failed._tag).toBe("Failure")
        expect(
          yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_note'`),
        ).toBeUndefined()
        expect(yield* db.get(sql`SELECT count(*) AS count FROM migration WHERE id = ${memoryMigration.id}`)).toEqual({
          count: 0,
        })
        expect(yield* db.all(sql`SELECT * FROM sentinel`)).toEqual([{ value: "untouched" }])
        yield* db.run(sql`DROP INDEX memory_note_scope_key_idx`)
        yield* DatabaseMigration.applyOnly(db, [memoryMigration])
        expect(yield* db.get(sql`SELECT count(*) AS count FROM memory_note`)).toEqual({ count: 0 })
      }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
    )
  })

  test("fresh schema and upgrade use the same memory columns and indexes", async () => {
    const inspect = (fresh: boolean) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const db = yield* EffectDrizzleSqlite.makeWithDefaults()
          if (fresh) yield* DatabaseMigration.apply(db)
          if (!fresh) yield* DatabaseMigration.applyOnly(db, [memoryMigration])
          return {
            columns: yield* db.all(sql`PRAGMA table_info(memory_note)`),
            indexes: yield* db.all(
              sql`SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'memory_note' ORDER BY name`,
            ),
          }
        }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
      )
    expect(await inspect(true)).toEqual(await inspect(false))
  })
})
