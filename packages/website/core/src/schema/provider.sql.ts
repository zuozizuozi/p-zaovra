import { pgTable, text, uniqueIndex, varchar } from "drizzle-orm/pg-core"
import { timestamps, workspaceColumns } from "../drizzle/types"
import { workspaceIndexes } from "./workspace.sql"

export const ProviderTable = pgTable(
  "provider",
  {
    ...workspaceColumns,
    ...timestamps,
    provider: varchar("provider", { length: 64 }).notNull(),
    credentials: text("credentials").notNull(),
  },
  (table) => [...workspaceIndexes(table), uniqueIndex("workspace_provider").on(table.workspaceID, table.provider)],
)
