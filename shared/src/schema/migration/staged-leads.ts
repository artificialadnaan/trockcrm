import {
  pgSchema,
  uuid,
  varchar,
  text,
  timestamp,
  jsonb,
  numeric,
  date,
  integer,
  index,
} from "drizzle-orm/pg-core";

const migrationSchema = pgSchema("migration");

export const stagedLeads = migrationSchema.table(
  "staged_leads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    officeId: uuid("office_id"),
    importRunId: uuid("import_run_id"),
    hubspotLeadId: varchar("hubspot_lead_id", { length: 100 }).unique().notNull(),
    rawData: jsonb("raw_data").notNull(),
    mappedName: varchar("mapped_name", { length: 500 }),
    mappedCompanyName: varchar("mapped_company_name", { length: 500 }),
    mappedPropertyName: varchar("mapped_property_name", { length: 500 }),
    mappedDealName: varchar("mapped_deal_name", { length: 500 }),
    candidateDealCount: integer("candidate_deal_count").default(0).notNull(),
    candidatePropertyCount: integer("candidate_property_count").default(0).notNull(),
    mappedOwnerEmail: varchar("mapped_owner_email", { length: 255 }),
    mappedSourceStage: varchar("mapped_source_stage", { length: 100 }),
    mappedAmount: numeric("mapped_amount", { precision: 14, scale: 2 }),
    mappedCloseDate: date("mapped_close_date"),
    validationStatus: varchar("validation_status", { length: 50 }).default("pending").notNull(),
    validationErrors: jsonb("validation_errors").default([]).notNull(),
    validationWarnings: jsonb("validation_warnings").default([]).notNull(),
    exceptionBucket: varchar("exception_bucket", { length: 100 }),
    exceptionReason: text("exception_reason"),
    reviewedBy: uuid("reviewed_by"),
    reviewNotes: text("review_notes"),
    promotedAt: timestamp("promoted_at", { withTimezone: true }),
    promotedLeadId: uuid("promoted_lead_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("staged_leads_office_id_idx").on(table.officeId)]
);
