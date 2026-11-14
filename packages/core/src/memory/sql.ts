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
