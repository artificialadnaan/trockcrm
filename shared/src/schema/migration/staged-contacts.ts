import {
  pgSchema,
  uuid,
  varchar,
  text,
  timestamp,
  jsonb,
  numeric,
} from "drizzle-orm/pg-core";

const migrationSchema = pgSchema("migration");

export const stagedContacts = migrationSchema.table("staged_contacts", {
  id: uuid("id").primaryKey().defaultRandom(),
  hubspotContactId: varchar("hubspot_contact_id", { length: 100 }).unique().notNull(),
  rawData: jsonb("raw_data").notNull(),
  mappedFirstName: varchar("mapped_first_name", { length: 255 }),
  mappedLastName: varchar("mapped_last_name", { length: 255 }),
  mappedEmail: varchar("mapped_email", { length: 255 }),
  mappedPhone: varchar("mapped_phone", { length: 50 }),
  mappedCompany: varchar("mapped_company", { length: 500 }),
  mappedCategory: varchar("mapped_category", { length: 50 }).default("other").notNull(),
  duplicateOfStagedId: uuid("duplicate_of_staged_id"),
  duplicateOfLiveId: uuid("duplicate_of_live_id"),
  duplicateConfidence: numeric("duplicate_confidence", { precision: 5, scale: 2 }),
  validationStatus: varchar("validation_status", { length: 50 }).default("pending").notNull(),
  validationErrors: jsonb("validation_errors").default([]).notNull(),
  validationWarnings: jsonb("validation_warnings").default([]).notNull(),
  reviewedBy: uuid("reviewed_by"),
  reviewNotes: text("review_notes"),
  mergeTargetId: uuid("merge_target_id"),
  promotedAt: timestamp("promoted_at", { withTimezone: true }),
  promotedContactId: uuid("promoted_contact_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
