import {
  jsonb,
  pgEnum,
  pgTable,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./users.js";

export const localAuthEventTypeEnum = pgEnum("local_auth_event_type", [
  "invite_previewed",
  "invite_sent",
  "invite_resent",
  "invite_revoked",
  "login_succeeded",
  "login_failed",
  "login_locked",
  "password_changed",
  "password_change_forced",
  "password_reset_requested",
  "password_reset_completed",
]);

export const userLocalAuthEvents = pgTable("user_local_auth_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").references(() => users.id).notNull(),
  eventType: localAuthEventTypeEnum("event_type").notNull(),
  actorUserId: uuid("actor_user_id"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
