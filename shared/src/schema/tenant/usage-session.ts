import { pgTable, uuid, integer, varchar, timestamp, index } from "drizzle-orm/pg-core";

export const usageSession = pgTable(
  "usage_session",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    activeSeconds: integer("active_seconds").default(0).notNull(),
    userAgent: varchar("user_agent", { length: 500 }),
    impersonatorId: uuid("impersonator_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("usage_session_user_started_idx").on(table.userId, table.startedAt),
  ],
);
