import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  text,
  boolean,
  timestamp,
  index,
  numeric,
} from "drizzle-orm/pg-core";
import { LEAD_STATUSES } from "../../types/enums.js";
import { users } from "../public/users.js";
import { companies } from "./companies.js";
import { contacts } from "./contacts.js";
import { properties } from "./properties.js";

export const leadStatusEnum = pgEnum("lead_status", LEAD_STATUSES);

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
  ]
);
