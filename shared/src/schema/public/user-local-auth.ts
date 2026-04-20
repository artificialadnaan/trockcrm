import {
  boolean,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./users.js";

export const userLocalAuth = pgTable("user_local_auth", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id),
  passwordHash: text("password_hash").notNull(),
  mustChangePassword: boolean("must_change_password").default(true).notNull(),
  isEnabled: boolean("is_enabled").default(true).notNull(),
  inviteSentAt: timestamp("invite_sent_at", { withTimezone: true }),
  inviteSentByUserId: uuid("invite_sent_by_user_id"),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  passwordChangedAt: timestamp("password_changed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
