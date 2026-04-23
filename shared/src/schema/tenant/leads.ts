import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  text,
  boolean,
  jsonb,
  numeric,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import {
  LEAD_STATUSES,
} from "../../types/enums.js";
import {
  SALES_WORKFLOW_DISQUALIFICATION_REASONS,
  SALES_WORKFLOW_PIPELINE_TYPES,
} from "../../types/sales-workflow.js";
import { users } from "../public/users.js";
import { companies } from "./companies.js";
import { contacts } from "./contacts.js";
import { projectTypeConfig } from "../public/project-type-config.js";
import { properties } from "./properties.js";

export const leadStatusEnum = pgEnum("lead_status", LEAD_STATUSES);
export const leadPipelineTypeEnum = pgEnum("lead_pipeline_type", SALES_WORKFLOW_PIPELINE_TYPES);
export const leadDisqualificationReasonEnum = pgEnum(
  "lead_disqualification_reason",
  SALES_WORKFLOW_DISQUALIFICATION_REASONS
);

export const leads = pgTable(
  "leads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").references(() => companies.id).notNull(),
    propertyId: uuid("property_id").references(() => properties.id).notNull(),
    primaryContactId: uuid("primary_contact_id").references(() => contacts.id),
    name: varchar("name", { length: 500 }).notNull(),
    stageId: uuid("stage_id").notNull(),
    assignedRepId: uuid("assigned_rep_id").references(() => users.id).notNull(),
    pipelineType: leadPipelineTypeEnum("pipeline_type").default("normal").notNull(),
    status: leadStatusEnum("status").default("open").notNull(),
    source: varchar("source", { length: 100 }),
    description: text("description"),
    existingCustomerResolution: varchar("existing_customer_resolution", { length: 50 }),
    existingCustomerResolvedAt: timestamp("existing_customer_resolved_at", { withTimezone: true }),
    existingCustomerResolvedBy: uuid("existing_customer_resolved_by").references(() => users.id),
    projectTypeId: uuid("project_type_id").references(() => projectTypeConfig.id),
    qualificationPayload: jsonb("qualification_payload").default({}).notNull(),
    projectTypeQuestionPayload: jsonb("project_type_question_payload").default({}).notNull(),
    preQualValue: numeric("pre_qual_value", { precision: 14, scale: 2 }),
    submissionStartedAt: timestamp("submission_started_at", { withTimezone: true }),
    submissionCompletedAt: timestamp("submission_completed_at", { withTimezone: true }),
    submissionDurationSeconds: integer("submission_duration_seconds"),
    executiveDecision: varchar("executive_decision", { length: 50 }),
    executiveDecisionAt: timestamp("executive_decision_at", { withTimezone: true }),
    executiveDecisionBy: uuid("executive_decision_by").references(() => users.id),
    disqualificationReason: leadDisqualificationReasonEnum("disqualification_reason"),
    disqualificationReasonNotes: text("disqualification_reason_notes"),
    disqualifiedAt: timestamp("disqualified_at", { withTimezone: true }),
    disqualifiedBy: uuid("disqualified_by").references(() => users.id),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }),
    stageEnteredAt: timestamp("stage_entered_at", { withTimezone: true }).defaultNow().notNull(),
    convertedAt: timestamp("converted_at", { withTimezone: true }),
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("leads_company_id_idx").on(table.companyId),
    index("leads_property_id_idx").on(table.propertyId),
    index("leads_assigned_rep_id_idx").on(table.assignedRepId),
    index("leads_stage_id_idx").on(table.stageId),
  ]
);
