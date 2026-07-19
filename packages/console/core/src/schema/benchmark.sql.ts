import { index, pgTable, primaryKey, text, varchar } from "drizzle-orm/pg-core"
import { id, timestamps } from "../drizzle/types"

export const BenchmarkTable = pgTable(
  "benchmark",
  {
    id: id(),
    ...timestamps,
    model: varchar("model", { length: 64 }).notNull(),
    agent: varchar("agent", { length: 64 }).notNull(),
    result: text("result").notNull(),
  },
  (table) => [primaryKey({ columns: [table.id] }), index("time_created").on(table.timeCreated)],
)
