import {
  boolean,
  integer,
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
  inviteExpiresAt: timestamp("invite_expires_at", { withTimezone: true }),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  failedLoginAttempts: integer("failed_login_attempts").default(0).notNull(),
  lastFailedLoginAt: timestamp("last_failed_login_at", { withTimezone: true }),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
  passwordChangedAt: timestamp("password_changed_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revokedByUserId: uuid("revoked_by_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
