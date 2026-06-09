import { pgTable, bigserial, uuid, text, timestamp, index } from "drizzle-orm/pg-core";

export const usageViewEvent = pgTable(
  "usage_view_event",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: uuid("user_id").notNull(),
    sessionId: uuid("session_id").notNull(),
    at: timestamp("at", { withTimezone: true }).defaultNow().notNull(),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id"),
    route: text("route").notNull(),
    labelSnapshot: text("label_snapshot"),
  },
  (table) => [
    index("usage_view_event_user_at_idx").on(table.userId, table.at),
  ],
);
