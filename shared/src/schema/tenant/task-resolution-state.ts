import {
  pgTable,
  uuid,
  varchar,
  jsonb,
  timestamp,
  unique,
  index,
} from "drizzle-orm/pg-core";

export const taskResolutionState = pgTable(
  "task_resolution_state",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id").notNull(),
    originRule: varchar("origin_rule", { length: 120 }).notNull(),
    dedupeKey: varchar("dedupe_key", { length: 255 }).notNull(),
    resolution: varchar("resolution", { length: 50 }).notNull(),
    reasonCode: varchar("reason_code", { length: 120 }),
    details: jsonb("details"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique().on(table.taskId),
    index("task_resolution_state_origin_rule_dedupe_key_idx").on(table.originRule, table.dedupeKey),
  ]
);
