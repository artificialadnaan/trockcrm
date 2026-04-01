import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  text,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { ACTIVITY_TYPES } from "../../types/enums.js";

export const activityTypeEnum = pgEnum("activity_type", ACTIVITY_TYPES);

export const activities = pgTable(
  "activities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: activityTypeEnum("type").notNull(),
    userId: uuid("user_id").notNull(),
    dealId: uuid("deal_id"),
    contactId: uuid("contact_id"),
    emailId: uuid("email_id"),
    subject: varchar("subject", { length: 500 }),
    body: text("body"),
    outcome: varchar("outcome", { length: 100 }),
    durationMinutes: integer("duration_minutes"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("activities_user_idx").on(table.userId, table.occurredAt),
    index("activities_deal_idx").on(table.dealId, table.occurredAt),
    index("activities_contact_idx").on(table.contactId, table.occurredAt),
  ]
);
