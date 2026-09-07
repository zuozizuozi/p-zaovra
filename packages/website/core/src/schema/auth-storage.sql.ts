import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core"

export const AuthStorageTable = pgTable("openauth_storage", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  expiry: timestamp("expiry", { withTimezone: true }),
})
