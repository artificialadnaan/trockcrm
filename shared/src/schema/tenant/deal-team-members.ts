import {
  pgTable,
  pgEnum,
  uuid,
  text,
  boolean,
  timestamp,
} from "drizzle-orm/pg-core";

export const dealTeamRoleEnum = pgEnum("deal_team_role", [
  "superintendent",
  "estimator",
  "project_manager",
  "foreman",
  "other",
]);

export const dealTeamMembers = pgTable("deal_team_members", {
  id: uuid("id").primaryKey().defaultRandom(),
  dealId: uuid("deal_id").notNull(),
  userId: uuid("user_id").notNull(),
  role: dealTeamRoleEnum("role").notNull(),
  assignedBy: uuid("assigned_by"),
  notes: text("notes"),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
