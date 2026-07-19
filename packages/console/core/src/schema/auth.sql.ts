import { index, pgEnum, pgTable, primaryKey, uniqueIndex, varchar } from "drizzle-orm/pg-core"
import { id, timestamps, ulid } from "../drizzle/types"

export const AuthProvider = ["email", "github", "google"] as const
const authProvider = pgEnum("auth_provider", AuthProvider)

export const AuthTable = pgTable(
  "auth",
  {
    id: id(),
    ...timestamps,
    provider: authProvider("provider").notNull(),
    subject: varchar("subject", { length: 255 }).notNull(),
    accountID: ulid("account_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    uniqueIndex("provider").on(table.provider, table.subject),
    index("account_id").on(table.accountID),
  ],
)
