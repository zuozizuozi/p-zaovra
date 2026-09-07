import { pgTable, uniqueIndex, varchar } from "drizzle-orm/pg-core"
import { timestamps, workspaceColumns } from "../drizzle/types"
import { workspaceIndexes } from "./workspace.sql"

export const ModelTable = pgTable(
  "model",
  {
    ...workspaceColumns,
    ...timestamps,
    model: varchar("model", { length: 64 }).notNull(),
  },
  (table) => [...workspaceIndexes(table), uniqueIndex("model_workspace_model").on(table.workspaceID, table.model)],
)
