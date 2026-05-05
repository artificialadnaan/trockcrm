import {
  pgTable,
  uuid,
  text,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { users } from "./users.js";

// TODO: Per-office recipient scoping. Currently global across all tenants.
// When T Rock onboards multiple offices and needs different DD recipients per
// office, add office_id to notificationRecipientAssignments and adjust
// filtering in getLeadDueDiligenceRecipients.
export const notificationRecipientGroups = pgTable(
  "notification_recipient_groups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("notification_recipient_groups_key_uidx").on(table.key),
  ]
);

export const notificationRecipientAssignments = pgTable(
  "notification_recipient_assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    groupId: uuid("group_id").references(() => notificationRecipientGroups.id, { onDelete: "cascade" }).notNull(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("notification_recipient_assignments_group_user_uidx").on(table.groupId, table.userId),
    index("notification_recipient_assignments_group_idx").on(table.groupId),
    index("notification_recipient_assignments_user_idx").on(table.userId),
  ]
);
