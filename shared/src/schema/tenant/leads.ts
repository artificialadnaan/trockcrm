import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  text,
  boolean,
  integer,
  numeric,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import {
  FORECAST_CATEGORIES,
  FORECAST_WINDOWS,
  LEAD_STATUSES,
  SUPPORT_NEEDED_TYPES,
} from "../../types/enums.js";
import { users } from "../public/users.js";
import { companies } from "./companies.js";
import { contacts } from "./contacts.js";
import { properties } from "./properties.js";

export const leadStatusEnum = pgEnum("lead_status", LEAD_STATUSES);
export const forecastWindowEnum = pgEnum("forecast_window", FORECAST_WINDOWS);
export const forecastCategoryEnum = pgEnum("forecast_category", FORECAST_CATEGORIES);
export const supportNeededTypeEnum = pgEnum("support_needed_type", SUPPORT_NEEDED_TYPES);

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
    status: leadStatusEnum("status").default("open").notNull(),
    source: varchar("source", { length: 100 }),
    description: text("description"),
    decisionMakerName: varchar("decision_maker_name", { length: 255 }),
    decisionProcess: text("decision_process"),
    budgetStatus: varchar("budget_status", { length: 100 }),
    incumbentVendor: varchar("incumbent_vendor", { length: 255 }),
    unitCount: integer("unit_count"),
    buildYear: integer("build_year"),
    forecastWindow: forecastWindowEnum("forecast_window"),
    forecastCategory: forecastCategoryEnum("forecast_category"),
    forecastConfidencePercent: integer("forecast_confidence_percent"),
    forecastRevenue: numeric("forecast_revenue", { precision: 14, scale: 2 }),
    forecastGrossProfit: numeric("forecast_gross_profit", { precision: 14, scale: 2 }),
    forecastBlockers: text("forecast_blockers"),
    nextStep: text("next_step"),
    nextStepDueAt: timestamp("next_step_due_at", { withTimezone: true }),
    nextMilestoneAt: timestamp("next_milestone_at", { withTimezone: true }),
    supportNeededType: supportNeededTypeEnum("support_needed_type"),
    supportNeededNotes: text("support_needed_notes"),
    forecastUpdatedAt: timestamp("forecast_updated_at", { withTimezone: true }),
    forecastUpdatedBy: uuid("forecast_updated_by").references(() => users.id),
    qualificationScope: varchar("qualification_scope", { length: 255 }),
    qualificationBudgetAmount: numeric("qualification_budget_amount", { precision: 12, scale: 2 }),
    qualificationCompanyFit: boolean("qualification_company_fit"),
    qualificationCompletedAt: timestamp("qualification_completed_at", { withTimezone: true }),
    directorReviewDecision: varchar("director_review_decision", { length: 20 }),
    directorReviewedAt: timestamp("director_reviewed_at", { withTimezone: true }),
    directorReviewedBy: uuid("director_reviewed_by").references(() => users.id),
    directorReviewReason: text("director_review_reason"),
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
    index("leads_forecast_window_idx").on(table.forecastWindow),
    index("leads_support_needed_type_idx").on(table.supportNeededType),
  ]
);
