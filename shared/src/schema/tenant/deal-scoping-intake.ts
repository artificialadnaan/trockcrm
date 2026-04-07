import { pgEnum, pgTable, jsonb, timestamp, uuid } from "drizzle-orm/pg-core";
import { DEAL_SCOPING_INTAKE_STATUSES } from "../../types/enums.js";
import { offices } from "../public/offices.js";
import { projectTypeConfig } from "../public/project-type-config.js";
import { users } from "../public/users.js";
import { deals, workflowRouteEnum } from "./deals.js";

export const dealScopingIntakeStatusEnum = pgEnum(
  "deal_scoping_intake_status",
  DEAL_SCOPING_INTAKE_STATUSES
);

export interface DealScopingIntakeMigrationGuardRow {
  dealId?: string | null;
  officeId?: string | null;
  createdBy?: string | null;
  lastEditedBy?: string | null;
}

export function assertDealScopingIntakeMigrationGuard(
  schemaName: string,
  rows: DealScopingIntakeMigrationGuardRow[]
): void {
  const invalidRequiredColumns = [
    rows.some((row) => row.dealId == null) ? "deal_id" : null,
    rows.some((row) => row.officeId == null) ? "office_id" : null,
    rows.some((row) => row.createdBy == null) ? "created_by" : null,
    rows.some((row) => row.lastEditedBy == null) ? "last_edited_by" : null,
  ].filter((value): value is string => value !== null);

  if (invalidRequiredColumns.length > 0) {
    throw new Error(
      `Migration 0016 cannot enforce deal_scoping_intake constraints for schema ${schemaName} because existing rows have NULL values in required columns: ${invalidRequiredColumns.join(", ")}. Backfill these columns before rerunning this migration.`
    );
  }
}

export const dealScopingIntake = pgTable("deal_scoping_intake", {
  id: uuid("id").primaryKey().defaultRandom(),
  dealId: uuid("deal_id").references(() => deals.id).unique().notNull(),
  officeId: uuid("office_id").references(() => offices.id).notNull(),
  workflowRouteSnapshot: workflowRouteEnum("workflow_route_snapshot").notNull(),
  status: dealScopingIntakeStatusEnum("status").default("draft").notNull(),
  projectTypeId: uuid("project_type_id").references(() => projectTypeConfig.id),
  sectionData: jsonb("section_data").default({}).notNull(),
  completionState: jsonb("completion_state").default({}).notNull(),
  readinessErrors: jsonb("readiness_errors").default({}).notNull(),
  firstReadyAt: timestamp("first_ready_at", { withTimezone: true }),
  activatedAt: timestamp("activated_at", { withTimezone: true }),
  lastAutosavedAt: timestamp("last_autosaved_at", { withTimezone: true }).defaultNow().notNull(),
  createdBy: uuid("created_by").references(() => users.id).notNull(),
  lastEditedBy: uuid("last_edited_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
