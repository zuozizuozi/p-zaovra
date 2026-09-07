import { bigint, integer, pgTable, primaryKey, varchar } from "drizzle-orm/pg-core"
import { timestamps } from "../drizzle/types"

export const IpTable = pgTable(
  "ip",
  {
    ip: varchar("ip", { length: 45 }).notNull(),
    ...timestamps,
    usage: integer("usage"),
  },
  (table) => [primaryKey({ columns: [table.ip] })],
)

export const IpRateLimitTable = pgTable(
  "ip_rate_limit",
  {
    ip: varchar("ip", { length: 45 }).notNull(),
    interval: varchar("interval", { length: 10 }).notNull(),
    count: integer("count").notNull(),
  },
  (table) => [primaryKey({ columns: [table.ip, table.interval] })],
)

export const KeyRateLimitTable = pgTable(
  "key_rate_limit",
  {
    key: varchar("key", { length: 255 }).notNull(),
    interval: varchar("interval", { length: 40 }).notNull(),
    count: integer("count").notNull(),
  },
  (table) => [primaryKey({ columns: [table.key, table.interval] })],
)

export const ModelTpmRateLimitTable = pgTable(
  "model_tpm_rate_limit",
  {
    id: varchar("id", { length: 255 }).notNull(),
    interval: bigint("interval", { mode: "number" }).notNull(),
    count: integer("count").notNull(),
  },
  (table) => [primaryKey({ columns: [table.id, table.interval] })],
)

export const ModelTpsRateLimitTable = pgTable(
  "model_tps_rate_limit",
  {
    id: varchar("id", { length: 255 }).notNull(),
    interval: bigint("interval", { mode: "number" }).notNull(),
    qualify: integer("qualify").notNull(),
    unqualify: integer("unqualify").notNull(),
  },
  (table) => [primaryKey({ columns: [table.id, table.interval] })],
)

export const ModelStickyProviderTable = pgTable(
  "model_sticky_provider",
  {
    id: varchar("id", { length: 255 }).notNull(),
    ...timestamps,
    providerId: varchar("provider_id", { length: 255 }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.id] })],
)
