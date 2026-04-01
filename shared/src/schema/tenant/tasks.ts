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
  index,
} from "drizzle-orm/pg-core";
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
  ]
);
