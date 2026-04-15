import {
  pgSchema,
  uuid,
  varchar,
  text,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";

const migrationSchema = pgSchema("migration");

export const stagedCompanies = migrationSchema.table(
  "staged_companies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    officeId: uuid("office_id"),
    importRunId: uuid("import_run_id"),
    hubspotCompanyId: varchar("hubspot_company_id", { length: 100 }).unique().notNull(),
    rawData: jsonb("raw_data").notNull(),
    mappedName: varchar("mapped_name", { length: 500 }),
    mappedDomain: varchar("mapped_domain", { length: 255 }),
    mappedPhone: varchar("mapped_phone", { length: 50 }),
    mappedOwnerEmail: varchar("mapped_owner_email", { length: 255 }),
    mappedLeadHint: varchar("mapped_lead_hint", { length: 255 }),
    validationStatus: varchar("validation_status", { length: 50 }).default("pending").notNull(),
    validationErrors: jsonb("validation_errors").default([]).notNull(),
    validationWarnings: jsonb("validation_warnings").default([]).notNull(),
    exceptionBucket: varchar("exception_bucket", { length: 100 }),
    exceptionReason: text("exception_reason"),
    reviewedBy: uuid("reviewed_by"),
    reviewNotes: text("review_notes"),
    promotedAt: timestamp("promoted_at", { withTimezone: true }),
    promotedCompanyId: uuid("promoted_company_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("staged_companies_office_id_idx").on(table.officeId)]
);
