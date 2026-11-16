import { expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@zaovra-ai/effect-drizzle-sqlite"
import { DatabaseMigration } from "@zaovra-ai/core/database/migration"
import migration from "@zaovra-ai/core/database/migration/20261114170409_memory-tidy-budget"
import binding from "@zaovra-ai/core/database/migration/20261114182441_memory-tidy-input"
import automatic from "@zaovra-ai/core/database/migration/20261116054623_memory-automatic"
import { Effect } from "effect"
import { sql } from "drizzle-orm"

test("tidy migration preserves old data and an unsettled reservation across repeated startup", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()
      yield* db.run(sql`CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT)`)
      yield* db.run(sql`INSERT INTO session VALUES ('old', 'Keep')`)
      yield* db.run(sql`CREATE TABLE memory_note (id TEXT PRIMARY KEY, text TEXT)`)
      yield* db.run(sql`INSERT INTO memory_note VALUES ('old-note', 'User text')`)
      yield* DatabaseMigration.applyOnly(db, [migration])
      yield* db.run(sql`INSERT INTO memory_tidy_run
      (id, request_id, session_id, scope, directory, model, token_limit, daily_limit, state, time_created)
      VALUES ('r', 'click', 'new-session', 'scope', '/project', '{}', 200000, 1000000, 'cancelled', 1)`)
      yield* db.run(sql`INSERT INTO memory_tidy_day VALUES ('2026-11-15', 1000000)`)
      yield* db.run(sql`INSERT INTO memory_tidy_attempt (id, run_id, day, reserved, time_created)
      VALUES ('unknown', 'r', '2026-11-15', 120000, 1)`)
      yield* DatabaseMigration.applyOnly(db, [migration, binding, automatic])
      expect(yield* db.all(sql`SELECT * FROM memory_automatic`)).toEqual([])
      yield* db.run(sql`INSERT INTO memory_automatic
        (directory, scope, project_id, generation, enabled, model, token_limit, daily_limit, current_run, time_confirmed)
        VALUES ('/project', 'scope', 'global', 'consent', 0, '{}', 200000, 1000000, 'r', 1)`)
      yield* db.run(sql`INSERT INTO memory_automatic_run VALUES ('r', '/project', 'consent')`)
      yield* db.run(sql`INSERT INTO memory_automatic_source VALUES ('/project', 'old', 30, 20)`)
      yield* DatabaseMigration.applyOnly(db, [migration, binding, automatic])
      expect(yield* db.get(sql`SELECT enabled, current_run, generation FROM memory_automatic`)).toEqual({
        enabled: 0,
        current_run: "r",
        generation: "consent",
      })
      expect(yield* db.get(sql`SELECT seq, input_seq FROM memory_automatic_source`)).toEqual({ seq: 30, input_seq: 20 })
      expect(yield* db.get(sql`SELECT generation FROM memory_automatic_run`)).toEqual({ generation: "consent" })
      expect(yield* db.get(sql`SELECT input FROM memory_tidy_run WHERE id = 'r'`)).toEqual({ input: null })
      expect(yield* db.all(sql`SELECT * FROM session`)).toEqual([{ id: "old", title: "Keep" }])
      expect(yield* db.all(sql`SELECT * FROM memory_note`)).toEqual([{ id: "old-note", text: "User text" }])
      expect(
        yield* db.get(sql`SELECT reserved, actual, time_settled FROM memory_tidy_attempt WHERE id = 'unknown'`),
      ).toEqual({ reserved: 120000, actual: null, time_settled: null })
      expect(yield* db.get(sql`SELECT count(*) AS count FROM migration WHERE id = ${migration.id}`)).toEqual({
        count: 1,
      })
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )
})
