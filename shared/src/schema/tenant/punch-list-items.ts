import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  text,
  boolean,
  timestamp,
} from "drizzle-orm/pg-core";
import { taskPriorityEnum } from "./tasks.js";

export const punchListTypeEnum = pgEnum("punch_list_type", [
  "internal",
  "external",
]);

export const punchListStatusEnum = pgEnum("punch_list_status", [
  "open",
  "in_progress",
  "completed",
]);

export const punchListItems = pgTable("punch_list_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  dealId: uuid("deal_id").notNull(),
  type: punchListTypeEnum("type").notNull(),
  title: varchar("title", { length: 500 }).notNull(),
  description: text("description"),
  status: punchListStatusEnum("status").default("open").notNull(),
  assignedTo: uuid("assigned_to"),
  location: varchar("location", { length: 255 }),
  priority: taskPriorityEnum("priority").default("normal").notNull(),
  photoIds: text("photo_ids").array().default([]),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  completedBy: uuid("completed_by"),
  createdBy: uuid("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
