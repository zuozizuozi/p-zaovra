import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../database/schema.sql"
import type { Memory } from "@zaovra-ai/schema/memory"
import type { SessionSchema } from "../session/schema"

export const MemoryNoteTable = sqliteTable(
  "memory_note",
  {
    id: text().$type<Memory.ID>().primaryKey(),
    // A project ID, or "user" for the layer that follows the user across projects. Not a foreign
    // key: notes outlive a project row that is recreated for the same directory.
    scope: text().$type<Memory.Scope>().notNull(),
    // Identity of the fact inside its scope. A deleted note keeps its key so the same fact is not
    // recorded again behind the user's back.
    key: text().notNull(),
    kind: text().$type<Memory.Kind>().notNull(),
    text: text().notNull(),
    origin: text().$type<Memory.Origin>().notNull(),
    status: text().$type<Memory.Status>().notNull(),
    verification: text(),
    session_id: text().$type<SessionSchema.ID>(),
    seq: integer(),
    hits: integer().notNull().default(1),
    time_observed: integer().notNull(),
    time_deleted: integer(),
    ...Timestamps,
  },
  (table) => [
    uniqueIndex("memory_note_scope_key_idx").on(table.scope, table.key),
    index("memory_note_scope_time_updated_idx").on(table.scope, table.time_updated),
  ],
)

/** A directory's explicit recovery choice; old buckets remain immutable. */
export const MemoryRecoveryTable = sqliteTable("memory_recovery", {
  scope: text().$type<Memory.Scope>().primaryKey(),
  legacy_scope: text().$type<Memory.Scope>().notNull(),
  directory: text().notNull(),
  state: text().$type<"pending" | "restored" | "blank">().notNull().default("pending"),
  ...Timestamps,
})

/** One explicit destination per old note; retries and subsequent deletion never copy it again. */
export const MemoryRecoveryClaimTable = sqliteTable("memory_recovery_claim", {
  note_id: text().$type<Memory.ID>().primaryKey(),
  scope: text().$type<Memory.Scope>().notNull(),
  restored_id: text().$type<Memory.ID>().notNull(),
  ...Timestamps,
})
