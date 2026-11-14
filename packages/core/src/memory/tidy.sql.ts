import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import type { Memory } from "@zaovra-ai/schema/memory"
import type { ModelV2 } from "../model"
import type { SessionSchema } from "../session/schema"
import type { SessionMessage } from "../session/message"

// Accounting survives deletion of its Session. No cascading Session foreign key.
export const MemoryTidyRunTable = sqliteTable(
  "memory_tidy_run",
  {
    id: text().primaryKey(),
    request_id: text().notNull().unique(),
    session_id: text().$type<SessionSchema.ID>().notNull(),
    input: text({ mode: "json" }).$type<{ id: SessionMessage.ID; seq: number }>(),
    scope: text().$type<Memory.Scope>().notNull(),
    directory: text().notNull(),
    model: text({ mode: "json" }).$type<ModelV2.Ref>().notNull(),
    token_limit: integer().notNull(),
    daily_limit: integer().notNull(),
    state: text().$type<"active" | "completed" | "cancelled" | "failed">().notNull(),
    time_created: integer().notNull(),
    time_finished: integer(),
  },
  (table) => [uniqueIndex("memory_tidy_run_session_idx").on(table.session_id)],
)

export const MemoryTidyDayTable = sqliteTable("memory_tidy_day", {
  day: text().primaryKey(),
  // The lowest confirmed limit used that UTC day; a new run cannot raise it.
  token_limit: integer().notNull(),
})

export const MemoryTidyAttemptTable = sqliteTable(
  "memory_tidy_attempt",
  {
    id: text().primaryKey(),
    run_id: text()
      .notNull()
      .references(() => MemoryTidyRunTable.id),
    day: text()
      .notNull()
      .references(() => MemoryTidyDayTable.day),
    reserved: integer().notNull(),
    actual: integer(),
    time_created: integer().notNull(),
    time_settled: integer(),
  },
  (table) => [
    index("memory_tidy_attempt_run_idx").on(table.run_id),
    index("memory_tidy_attempt_day_idx").on(table.day),
  ],
)
