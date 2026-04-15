import {
  pgSchema,
  uuid,
  varchar,
  text,
  timestamp,
  jsonb,
  integer,
  index,
} from "drizzle-orm/pg-core";

const migrationSchema = pgSchema("migration");

export const stagedProperties = migrationSchema.table(
  "staged_properties",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    officeId: uuid("office_id"),
    importRunId: uuid("import_run_id"),
    hubspotPropertyId: varchar("hubspot_property_id", { length: 100 }).unique().notNull(),
    rawData: jsonb("raw_data").notNull(),
    mappedName: varchar("mapped_name", { length: 500 }),
    mappedCompanyName: varchar("mapped_company_name", { length: 500 }),
    mappedCompanyDomain: varchar("mapped_company_domain", { length: 255 }),
    mappedAddress: varchar("mapped_address", { length: 500 }),
    mappedCity: varchar("mapped_city", { length: 255 }),
    mappedState: varchar("mapped_state", { length: 100 }),
    mappedZip: varchar("mapped_zip", { length: 20 }),
    candidateCompanyCount: integer("candidate_company_count").default(0).notNull(),
    mappedOwnerEmail: varchar("mapped_owner_email", { length: 255 }),
    validationStatus: varchar("validation_status", { length: 50 }).default("pending").notNull(),
    validationErrors: jsonb("validation_errors").default([]).notNull(),
    validationWarnings: jsonb("validation_warnings").default([]).notNull(),
    exceptionBucket: varchar("exception_bucket", { length: 100 }),
    exceptionReason: text("exception_reason"),
    reviewedBy: uuid("reviewed_by"),
    reviewNotes: text("review_notes"),
    promotedAt: timestamp("promoted_at", { withTimezone: true }),
    promotedPropertyId: uuid("promoted_property_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("staged_properties_office_id_idx").on(table.officeId)]
);
