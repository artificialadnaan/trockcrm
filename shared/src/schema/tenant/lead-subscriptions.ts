import { pgTable, uuid, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";

export const leadSubscriptions = pgTable(
  "lead_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leadId: uuid("lead_id").notNull(),
    userId: uuid("user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("lead_subscriptions_lead_user_uidx").on(table.leadId, table.userId),
    index("lead_subscriptions_user_idx").on(table.userId, table.deletedAt),
  ]
);
