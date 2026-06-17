import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  text,
  boolean,
  jsonb,
  timestamp,
  integer,
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
  // P2-8 (migration 0142): roster-hygiene flag. Excludes smoke-test accounts + a flagged
  // duplicate human row from the director dashboard rosters. Does NOT affect any financial
  // total -- Won filters test DEALS (deals.is_test_data), not users.
  isTestData: boolean("is_test_data").default(false).notNull(),
  notificationPrefs: jsonb("notification_prefs").default({}).notNull(),
  // Per-user CRM email signature (sanitized HTML; a logo is an <img> pointing at the public
  // signature-logo asset route). Appended to user-composed outbound mail in sendEmail; null/empty
  // = no signature. NOT applied to system/Resend mail. (migration 0161)
  emailSignature: text("email_signature"),
  reportsTo: uuid("reports_to"),
  createdByUserId: uuid("created_by_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  tokenVersion: integer("token_version").notNull().default(0),
});
