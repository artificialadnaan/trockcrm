import { jsonb, pgEnum, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { LEAD_SCOPING_INTAKE_STATUSES } from "../../types/enums.js";
import { offices } from "../public/offices.js";
import { users } from "../public/users.js";
import { leads } from "./leads.js";

export const leadScopingIntakeStatusEnum = pgEnum(
  "lead_scoping_intake_status",
  LEAD_SCOPING_INTAKE_STATUSES
);

export const leadScopingIntake = pgTable("lead_scoping_intake", {
  id: uuid("id").primaryKey().defaultRandom(),
  leadId: uuid("lead_id").references(() => leads.id).unique().notNull(),
  officeId: uuid("office_id").references(() => offices.id).notNull(),
  status: leadScopingIntakeStatusEnum("status").default("draft").notNull(),
  sectionData: jsonb("section_data").default({}).notNull(),
  completionState: jsonb("completion_state").default({}).notNull(),
  readinessErrors: jsonb("readiness_errors").default({}).notNull(),
  firstReadyAt: timestamp("first_ready_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  lastAutosavedAt: timestamp("last_autosaved_at", { withTimezone: true }).defaultNow().notNull(),
  createdBy: uuid("created_by").references(() => users.id).notNull(),
  lastEditedBy: uuid("last_edited_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
