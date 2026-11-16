import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { SessionTable } from "./session/sql"

/** Host-only observations, committed in the same transaction as Tool.Success. */
export const ReadReceiptTable = sqliteTable(
  "read_receipt",
  {
    id: text().primaryKey(),
    session_id: text()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    assistant_message_id: text().notNull(),
    call_id: text().notNull(),
    called_seq: integer().notNull(),
    success_seq: integer().notNull(),
    directory: text().notNull(),
    project_id: text().notNull(),
    workspace_id: text(),
    path: text().notNull(),
    resource: text().notNull(),
    digest: text().notNull(),
    bytes: integer().notNull(),
    volume_id: text().notNull(),
    file_id: text().notNull(),
    written: text().notNull(),
    changed: text().notNull(),
  },
  (table) => [uniqueIndex("read_receipt_source_idx").on(table.session_id, table.assistant_message_id, table.call_id)],
)
