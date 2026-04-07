import { pgEnum, pgTable, jsonb, timestamp, uuid } from "drizzle-orm/pg-core";
import {
  DEAL_SCOPING_INTAKE_STATUSES,
  WORKFLOW_ROUTES,
} from "../../types/enums.js";

export const workflowRouteEnum = pgEnum("workflow_route", WORKFLOW_ROUTES);
export const dealScopingIntakeStatusEnum = pgEnum(
  "deal_scoping_intake_status",
  DEAL_SCOPING_INTAKE_STATUSES
);

export const dealScopingIntake = pgTable("deal_scoping_intake", {
  id: uuid("id").primaryKey().defaultRandom(),
  dealId: uuid("deal_id").notNull().unique(),
  officeId: uuid("office_id").notNull(),
  workflowRouteSnapshot: workflowRouteEnum("workflow_route_snapshot").notNull(),
  status: dealScopingIntakeStatusEnum("status").default("draft").notNull(),
  projectTypeId: uuid("project_type_id"),
  sectionData: jsonb("section_data").default({}).notNull(),
  completionState: jsonb("completion_state").default({}).notNull(),
  readinessErrors: jsonb("readiness_errors").default({}).notNull(),
  firstReadyAt: timestamp("first_ready_at", { withTimezone: true }),
  activatedAt: timestamp("activated_at", { withTimezone: true }),
  lastAutosavedAt: timestamp("last_autosaved_at", { withTimezone: true }).defaultNow().notNull(),
  createdBy: uuid("created_by").notNull(),
  lastEditedBy: uuid("last_edited_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
