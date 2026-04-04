import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  text,
  boolean,
  date,
  time,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { offices } from "../public/offices.js";
import { TASK_TYPES, TASK_PRIORITIES, TASK_STATUSES } from "../../types/enums.js";

export const taskTypeEnum = pgEnum("task_type", TASK_TYPES);
export const taskPriorityEnum = pgEnum("task_priority", TASK_PRIORITIES);
export const taskStatusEnum = pgEnum("task_status", TASK_STATUSES);

export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: varchar("title", { length: 500 }).notNull(),
    description: text("description"),
    type: taskTypeEnum("type").notNull(),
    priority: taskPriorityEnum("priority").default("normal").notNull(),
    status: taskStatusEnum("status").default("pending").notNull(),
    assignedTo: uuid("assigned_to").notNull(),
    createdBy: uuid("created_by"),
    officeId: uuid("office_id").references(() => offices.id),
    originRule: varchar("origin_rule", { length: 120 }),
    sourceRule: varchar("source_rule", { length: 120 }),
    sourceEvent: varchar("source_event", { length: 120 }),
    dedupeKey: varchar("dedupe_key", { length: 255 }),
    reasonCode: varchar("reason_code", { length: 120 }),
    entitySnapshot: jsonb("entity_snapshot"),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
    waitingOn: jsonb("waiting_on"),
    blockedBy: jsonb("blocked_by"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    dealId: uuid("deal_id"),
    contactId: uuid("contact_id"),
    emailId: uuid("email_id"),
    dueDate: date("due_date"),
    dueTime: time("due_time"),
    remindAt: timestamp("remind_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    isOverdue: boolean("is_overdue").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("tasks_assigned_status_idx").on(table.assignedTo, table.status, table.dueDate),
    index("tasks_priority_idx").on(table.assignedTo, table.status, table.priority),
    index("tasks_status_scheduled_for_idx").on(table.status, table.scheduledFor),
    uniqueIndex("tasks_active_origin_rule_dedupe_key_uidx")
      .on(table.originRule, table.dedupeKey)
      .where(
        sql`${table.originRule} IS NOT NULL AND ${table.dedupeKey} IS NOT NULL AND ${table.status} IN ('scheduled', 'pending', 'in_progress', 'waiting_on', 'blocked')`
      ),
    index("tasks_origin_rule_reason_code_idx").on(table.originRule, table.reasonCode),
  ]
);
