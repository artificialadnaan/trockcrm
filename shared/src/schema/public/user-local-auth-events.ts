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
]);

export const userLocalAuthEvents = pgTable("user_local_auth_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").references(() => users.id).notNull(),
  eventType: localAuthEventTypeEnum("event_type").notNull(),
  actorUserId: uuid("actor_user_id"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
