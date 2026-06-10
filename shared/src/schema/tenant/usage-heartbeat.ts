import { pgTable, bigserial, uuid, timestamp, index } from "drizzle-orm/pg-core";

export const usageHeartbeat = pgTable(
  "usage_heartbeat",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    sessionId: uuid("session_id").notNull(),
    userId: uuid("user_id").notNull(),
    at: timestamp("at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("usage_heartbeat_user_at_idx").on(table.userId, table.at),
    index("usage_heartbeat_session_idx").on(table.sessionId),
  ],
);
