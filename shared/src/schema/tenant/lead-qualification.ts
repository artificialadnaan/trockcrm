import { jsonb, numeric, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { leads } from "./leads.js";

export const leadQualification = pgTable("lead_qualification", {
  id: uuid("id").primaryKey().defaultRandom(),
  leadId: uuid("lead_id").references(() => leads.id).unique().notNull(),
  estimatedOpportunityValue: numeric("estimated_opportunity_value", { precision: 14, scale: 2 }),
  goDecision: varchar("go_decision", { length: 20 }),
  goDecisionNotes: text("go_decision_notes"),
  qualificationData: jsonb("qualification_data").default({}).notNull(),
  scopingSubsetData: jsonb("scoping_subset_data").default({}).notNull(),
  disqualificationReason: varchar("disqualification_reason", { length: 100 }),
  disqualificationNotes: text("disqualification_notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
