import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  jsonb,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { offices } from "../public/offices.js";
import { TASK_RESOLUTION_STATUSES } from "../../types/enums.js";

export const taskResolutionStatusEnum = pgEnum(
  "task_resolution_status",
  TASK_RESOLUTION_STATUSES
);

export const taskResolutionState = pgTable(
  "task_resolution_state",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    officeId: uuid("office_id").references(() => offices.id).notNull(),
    taskId: uuid("task_id").notNull(),
    originRule: varchar("origin_rule", { length: 120 }).notNull(),
    dedupeKey: varchar("dedupe_key", { length: 255 }).notNull(),
    resolutionStatus: taskResolutionStatusEnum("resolution_status").notNull(),
    resolutionReason: varchar("resolution_reason", { length: 120 }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    suppressedUntil: timestamp("suppressed_until", { withTimezone: true }),
    entitySnapshot: jsonb("entity_snapshot"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("task_resolution_state_origin_rule_dedupe_key_uidx").on(table.originRule, table.dedupeKey),
    index("task_resolution_state_reason_code_idx").on(table.resolutionReason),
  ]
);
