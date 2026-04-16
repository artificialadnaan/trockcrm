import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";

export const aiDisconnectCaseHistory = pgTable(
  "ai_disconnect_case_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    disconnectCaseId: uuid("disconnect_case_id").notNull(),
    actionType: varchar("action_type", { length: 40 }).notNull(),
    actedBy: uuid("acted_by").notNull(),
    actedAt: timestamp("acted_at", { withTimezone: true }).defaultNow().notNull(),
    fromStatus: varchar("from_status", { length: 20 }),
    toStatus: varchar("to_status", { length: 20 }),
    fromAssignee: uuid("from_assignee"),
    toAssignee: uuid("to_assignee"),
    fromSnoozedUntil: timestamp("from_snoozed_until", { withTimezone: true }),
    toSnoozedUntil: timestamp("to_snoozed_until", { withTimezone: true }),
    notes: text("notes"),
    metadataJson: jsonb("metadata_json"),
  },
  (table) => [
    index("ai_disconnect_case_history_case_idx").on(table.disconnectCaseId, table.actedAt),
  ]
);
