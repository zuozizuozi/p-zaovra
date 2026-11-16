import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"
import type { Memory } from "@zaovra-ai/schema/memory"
import type { ModelV2 } from "../model"
import type { ProjectV2 } from "../project"
import type { SessionSchema } from "../session/schema"

// User-confirmed host preferences, never loaded from project or model configuration.
export const MemoryAutomaticTable = sqliteTable("memory_automatic", {
  directory: text().primaryKey(),
  scope: text().$type<Memory.Scope>().notNull(),
  project_id: text().$type<ProjectV2.ID>().notNull(),
  generation: text().notNull(),
  enabled: integer({ mode: "boolean" }).notNull(),
  model: text({ mode: "json" }).$type<ModelV2.Ref>().notNull(),
  token_limit: integer().notNull(),
  daily_limit: integer().notNull(),
  current_run: text(),
  time_confirmed: integer().notNull(),
})

// Attempted source versions are not proof that the model reviewed every source.
// No cascading Session FK: deleting history must not recreate a paid attempt.
export const MemoryAutomaticSourceTable = sqliteTable(
  "memory_automatic_source",
  {
    directory: text().notNull(),
    session_id: text().$type<SessionSchema.ID>().notNull(),
    seq: integer().notNull(),
    input_seq: integer().notNull(),
  },
  (table) => [primaryKey({ columns: [table.directory, table.session_id] })],
)

// Keep the original consent generation even after preferences are replaced.
export const MemoryAutomaticRunTable = sqliteTable("memory_automatic_run", {
  run_id: text().primaryKey(),
  directory: text().notNull(),
  generation: text().notNull(),
})
