import {
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./users.js";

/**
 * Single-use password reset links for CRM local-auth users (migration 0226).
 *
 * Separate from `field_user_password_resets` on purpose: that flow's consume path filters
 * `role = 'field_contractor'`, so widening it would mean editing working field auth to ship a CRM
 * feature. `requested_by_user_id` NULL means self-service.
 */
export const userPasswordResets = pgTable(
  "user_password_resets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    requestedByUserId: uuid("requested_by_user_id").references(() => users.id, { onDelete: "set null" }),
    requestedIp: text("requested_ip"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("user_password_resets_active_user_idx")
      .on(table.userId, table.createdAt.desc())
      .where(sql`${table.usedAt} IS NULL AND ${table.invalidatedAt} IS NULL`),
    index("user_password_resets_user_created_idx").on(table.userId, table.createdAt.desc()),
  ]
);
