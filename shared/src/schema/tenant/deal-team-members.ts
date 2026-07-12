import {
  pgTable,
  pgEnum,
  uuid,
  text,
  boolean,
  timestamp,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const dealTeamRoleEnum = pgEnum("deal_team_role", [
  "superintendent",
  "estimator",
  "project_manager",
  "client_services",
  "operations",
  "foreman",
  "other",
]);

export const dealTeamMembers = pgTable(
  "deal_team_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dealId: uuid("deal_id").notNull(),
    userId: uuid("user_id"),
    contactId: uuid("contact_id"),
    role: dealTeamRoleEnum("role").notNull(),
    assignedBy: uuid("assigned_by"),
    notes: text("notes"),
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check(
      "deal_team_members_user_or_contact_check",
      sql`(${table.userId} is not null and ${table.contactId} is null) or (${table.userId} is null and ${table.contactId} is not null)`
    ),
  ]
);
