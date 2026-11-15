import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import type { Memory } from "@zaovra-ai/schema/memory"
import { Timestamps } from "../database/schema.sql"

export const MemoryPageTable = sqliteTable(
  "memory_page",
  {
    id: text().$type<Memory.PageID>().primaryKey(),
    scope: text().$type<Memory.Scope>().notNull(),
    key: text().notNull(),
    title: text().notNull(),
    summary: text().notNull(),
    body: text().notNull(),
    sources: text({ mode: "json" }).$type<ReadonlyArray<Memory.PageSource>>().notNull(),
    revision: text().notNull(),
    origin: text().$type<"consolidation" | "user">().notNull().default("consolidation"),
    // Only hashes are retained, so deleting a page can suppress every prior wording.
    aliases: text({ mode: "json" }).$type<ReadonlyArray<string>>().notNull(),
    time_deleted: integer(),
    ...Timestamps,
  },
  (table) => [
    uniqueIndex("memory_page_scope_key_idx").on(table.scope, table.key),
    index("memory_page_scope_updated_idx").on(table.scope, table.time_updated),
  ],
)

export const MemoryPageTombstoneTable = sqliteTable(
  "memory_page_tombstone",
  {
    scope: text().$type<Memory.Scope>().notNull(),
    key: text().notNull(),
    time_created: integer().notNull(),
  },
  (table) => [uniqueIndex("memory_page_tombstone_scope_key_idx").on(table.scope, table.key)],
)
