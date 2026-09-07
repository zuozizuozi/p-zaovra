import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core"
import { timestamps, ulid, utc, workspaceColumns } from "../drizzle/types"
import { workspaceIndexes } from "./workspace.sql"

export const BlackPlans = ["20", "100", "200"] as const
const blackPlan = pgEnum("black_plan", BlackPlans)
export const BillingTable = pgTable(
  "billing",
  {
    ...workspaceColumns,
    ...timestamps,
    customerID: varchar("customer_id", { length: 255 }),
    paymentMethodID: varchar("payment_method_id", { length: 255 }),
    paymentMethodType: varchar("payment_method_type", { length: 32 }),
    paymentMethodLast4: varchar("payment_method_last4", { length: 4 }),
    balance: bigint("balance", { mode: "number" }).notNull(),
    monthlyLimit: integer("monthly_limit"),
    monthlyUsage: bigint("monthly_usage", { mode: "number" }),
    timeMonthlyUsageUpdated: utc("time_monthly_usage_updated"),
    reload: boolean("reload"),
    reloadTrigger: integer("reload_trigger"),
    reloadAmount: integer("reload_amount"),
    reloadError: varchar("reload_error", { length: 255 }),
    timeReloadError: utc("time_reload_error"),
    timeReloadLockedTill: utc("time_reload_locked_till"),
    subscription: jsonb("subscription").$type<{
      status: "subscribed"
      seats: number
      plan: (typeof BlackPlans)[number]
      useBalance?: boolean
      coupon?: string
    }>(),
    subscriptionID: varchar("subscription_id", { length: 28 }),
    subscriptionPlan: blackPlan("subscription_plan"),
    timeSubscriptionBooked: utc("time_subscription_booked"),
    timeSubscriptionSelected: utc("time_subscription_selected"),
    liteSubscriptionID: varchar("lite_subscription_id", { length: 28 }),
    lite: jsonb("lite").$type<{
      useBalance?: boolean
    }>(),
  },
  (table) => [
    ...workspaceIndexes(table),
    uniqueIndex("global_customer_id").on(table.customerID),
    uniqueIndex("global_subscription_id").on(table.subscriptionID),
  ],
)

export const SubscriptionTable = pgTable(
  "subscription",
  {
    ...workspaceColumns,
    ...timestamps,
    userID: ulid("user_id").notNull(),
    rollingUsage: bigint("rolling_usage", { mode: "number" }),
    fixedUsage: bigint("fixed_usage", { mode: "number" }),
    timeRollingUpdated: utc("time_rolling_updated"),
    timeFixedUpdated: utc("time_fixed_updated"),
  },
  (table) => [...workspaceIndexes(table), uniqueIndex("subscription_workspace_user_id").on(table.workspaceID, table.userID)],
)

export const LiteTable = pgTable(
  "lite",
  {
    ...workspaceColumns,
    ...timestamps,
    userID: ulid("user_id").notNull(),
    rollingUsage: bigint("rolling_usage", { mode: "number" }),
    weeklyUsage: bigint("weekly_usage", { mode: "number" }),
    monthlyUsage: bigint("monthly_usage", { mode: "number" }),
    timeRollingUpdated: utc("time_rolling_updated"),
    timeWeeklyUpdated: utc("time_weekly_updated"),
    timeMonthlyUpdated: utc("time_monthly_updated"),
  },
  (table) => [...workspaceIndexes(table), uniqueIndex("lite_workspace_user_id").on(table.workspaceID, table.userID)],
)

export const PaymentTable = pgTable(
  "payment",
  {
    ...workspaceColumns,
    ...timestamps,
    customerID: varchar("customer_id", { length: 255 }),
    invoiceID: varchar("invoice_id", { length: 255 }),
    paymentID: varchar("payment_id", { length: 255 }),
    amount: bigint("amount", { mode: "number" }).notNull(),
    timeRefunded: utc("time_refunded"),
    enrichment: jsonb("enrichment").$type<
      | {
          type: "subscription" | "lite"
          currency?: "inr"
          couponID?: string
        }
      | {
          type: "credit"
        }
    >(),
  },
  (table) => [...workspaceIndexes(table)],
)

export const UsageTable = pgTable(
  "usage",
  {
    ...workspaceColumns,
    ...timestamps,
    model: varchar("model", { length: 255 }).notNull(),
    provider: varchar("provider", { length: 255 }).notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    reasoningTokens: integer("reasoning_tokens"),
    cacheReadTokens: integer("cache_read_tokens"),
    cacheWrite5mTokens: integer("cache_write_5m_tokens"),
    cacheWrite1hTokens: integer("cache_write_1h_tokens"),
    cost: bigint("cost", { mode: "number" }).notNull(),
    keyID: ulid("key_id"),
    sessionID: varchar("session_id", { length: 30 }),
    enrichment: jsonb("enrichment").$type<{
      plan: "sub" | "byok" | "lite"
    }>(),
  },
  (table) => [...workspaceIndexes(table), index("usage_time_created").on(table.workspaceID, table.timeCreated)],
)

export const CouponType = [
  "BUILDATHON",
  "GO1MONTH50",
  "GOFREEMONTH",
  "GO3MONTHS100",
  "GO6MONTHS100",
  "GO12MONTHS100",
] as const
const couponType = pgEnum("coupon_type", CouponType)
export const CouponTable = pgTable(
  "coupon",
  {
    email: varchar("email", { length: 255 }),
    type: couponType("type").notNull(),
    timeRedeemed: utc("time_redeemed"),
  },
  (table) => [primaryKey({ columns: [table.email, table.type] })],
)
