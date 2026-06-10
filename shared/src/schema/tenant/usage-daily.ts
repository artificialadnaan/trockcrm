import { pgTable, uuid, date, integer, jsonb, timestamp, primaryKey } from "drizzle-orm/pg-core";

export const usageDaily = pgTable(
  "usage_daily",
  {
    userId: uuid("user_id").notNull(),
    date: date("date").notNull(),
    activeSeconds: integer("active_seconds").default(0).notNull(),
    sessionCount: integer("session_count").default(0).notNull(),
    viewCount: integer("view_count").default(0).notNull(),
    actionCount: integer("action_count").default(0).notNull(),
    breakdown: jsonb("breakdown").notNull().default({}),
    firstActiveAt: timestamp("first_active_at", { withTimezone: true }),
    lastActiveAt: timestamp("last_active_at", { withTimezone: true }),
    rolledUpAt: timestamp("rolled_up_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.date] })],
);
