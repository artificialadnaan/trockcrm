import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  text,
  boolean,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { NOTIFICATION_TYPES } from "../../types/enums.js";

export const notificationTypeEnum = pgEnum("notification_type", NOTIFICATION_TYPES);

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull(),
    type: notificationTypeEnum("type").notNull(),
    title: varchar("title", { length: 500 }).notNull(),
    body: text("body"),
    link: varchar("link", { length: 1000 }),
    isRead: boolean("is_read").default(false).notNull(),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("notifications_user_unread_idx").on(table.userId, table.isRead, table.createdAt),
  ]
);
