import {
  pgTable,
  uuid,
  varchar,
  text,
  jsonb,
  timestamp,
  numeric,
  index,
} from "drizzle-orm/pg-core";

export const aiTaskSuggestions = pgTable(
  "ai_task_suggestions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    packetId: uuid("packet_id").notNull(),
    scopeType: varchar("scope_type", { length: 32 }).notNull(),
    scopeId: uuid("scope_id").notNull(),
    title: varchar("title", { length: 500 }).notNull(),
    description: text("description"),
    suggestedOwnerId: uuid("suggested_owner_id"),
    suggestedDueAt: timestamp("suggested_due_at", { withTimezone: true }),
    priority: varchar("priority", { length: 32 }).default("normal").notNull(),
    confidence: numeric("confidence", { precision: 5, scale: 4 }),
    evidenceJson: jsonb("evidence_json"),
    status: varchar("status", { length: 32 }).default("suggested").notNull(),
    acceptedTaskId: uuid("accepted_task_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => [
    index("ai_task_suggestions_scope_idx").on(table.scopeType, table.scopeId, table.status),
    index("ai_task_suggestions_packet_idx").on(table.packetId, table.status),
  ]
);
