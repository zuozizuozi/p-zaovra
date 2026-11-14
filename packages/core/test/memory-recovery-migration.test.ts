import { expect, test } from "bun:test"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@zaovra-ai/effect-drizzle-sqlite"
import { DatabaseMigration } from "../src/database/migration"
import { migrations } from "../src/database/migration.gen"
import memoryMigration from "../src/database/migration/20261113202309_agent-memory"

test("legacy memory recovery migrations add state without rewriting old notes or tombstones", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()
      yield* db.run(sql`CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT NOT NULL)`)
      yield* DatabaseMigration.applyOnly(db, [memoryMigration])
      yield* db.run(sql`INSERT INTO memory_note (id,scope,key,kind,text,origin,status,time_observed,time_deleted,time_created,time_updated)
      VALUES ('old','dir_old','old-key','practice','original','model','unverified',1,NULL,1,1),
             ('deleted','dir_old','deleted-key','practice','','program','unverified',1,2,1,2)`)
      const original = yield* db.all(sql`SELECT * FROM memory_note ORDER BY id`)
      const upgrades = migrations.filter(
        (migration) => migration.id.endsWith("memory-recovery") || migration.id.endsWith("memory-recovery-claim"),
      )
      expect(upgrades).toHaveLength(2)
      yield* DatabaseMigration.applyOnly(db, upgrades)
      yield* DatabaseMigration.applyOnly(db, upgrades)
      expect(yield* db.all(sql`SELECT * FROM memory_note ORDER BY id`)).toEqual(original)
      expect(yield* db.all(sql`SELECT * FROM memory_recovery`)).toEqual([])
      expect(yield* db.all(sql`SELECT * FROM memory_recovery_claim`)).toEqual([])
      expect(yield* db.get(sql`SELECT count(*) AS count FROM migration WHERE id LIKE '%memory-recovery%'`)).toEqual({
        count: 2,
      })
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )
})
