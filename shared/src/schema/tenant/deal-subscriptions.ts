import { pgTable, uuid, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";

export const dealSubscriptions = pgTable(
  "deal_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dealId: uuid("deal_id").notNull(),
    userId: uuid("user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("deal_subscriptions_deal_user_uidx").on(table.dealId, table.userId),
    index("deal_subscriptions_user_idx").on(table.userId, table.deletedAt),
  ]
);
