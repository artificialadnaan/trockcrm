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
  // Migration 0219: is this person expected to CARRY DEALS? Orthogonal to `role`, which answers the
  // separate question of what they may SEE/DO -- an estimator holds role='rep' purely for CRM access,
  // and a director may well run deals. Gates the director-dashboard ROSTERS only; it is deliberately
  // not read by the commission MONEY totals, so a roster edit can never move a financial figure.
  // Defaults true: ticking someone on is safe, removing them is the act that must be deliberate.
  generatesSales: boolean("generates_sales").default(true).notNull(),
  // Migration 0222: does this person ESTIMATE? The twin of the flag above, and the membership test for
  // the "Estimators" group of the deals/leads owner filters — an estimator who owns nothing was
  // unreachable, because a rep filter means OWNS (see buildOwnedRepCondition). Cannot be derived from
  // deals.estimator_user_id: that column is dominated by reps estimating their OWN deals, so deriving it
  // would file most of the sales team as estimators. Defaults FALSE (unlike generatesSales) because it
  // starts a new list nobody is on yet; ticking is the deliberate act.
  estimatesJobs: boolean("estimates_jobs").default(false).notNull(),
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
