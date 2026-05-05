import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  text,
  boolean,
  jsonb,
  timestamp,
} from "drizzle-orm/pg-core";
import { offices } from "./offices.js";
import { USER_ROLES } from "../../types/enums.js";

export const userRoleEnum = pgEnum("user_role", USER_ROLES);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: varchar("email", { length: 255 }).unique().notNull(),
  displayName: varchar("display_name", { length: 255 }).notNull(),
  firstName: varchar("first_name", { length: 255 }),
  lastName: varchar("last_name", { length: 255 }),
  phone: varchar("phone", { length: 30 }),
  azureAdId: varchar("azure_ad_id", { length: 255 }).unique(),
  avatarUrl: text("avatar_url"),
  role: userRoleEnum("role").notNull(),
  officeId: uuid("office_id")
    .references(() => offices.id)
    .notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  notificationPrefs: jsonb("notification_prefs").default({}).notNull(),
  reportsTo: uuid("reports_to"),
  createdByUserId: uuid("created_by_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
