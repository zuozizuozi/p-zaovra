import { pgTable, primaryKey } from "drizzle-orm/pg-core"
import { id, timestamps } from "../drizzle/types"

export const AccountTable = pgTable(
  "account",
  {
    id: id(),
    ...timestamps,
  },
  (table) => [primaryKey({ columns: [table.id] })],
)
