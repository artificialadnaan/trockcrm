import {
  pgSchema,
  uuid,
  varchar,
  text,
  numeric,
  date,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";

const migrationSchema = pgSchema("migration");

export const stagedDeals = migrationSchema.table("staged_deals", {
  id: uuid("id").primaryKey().defaultRandom(),
  officeId: uuid("office_id"),
  importRunId: uuid("import_run_id"),
  hubspotDealId: varchar("hubspot_deal_id", { length: 100 }).unique().notNull(),
  rawData: jsonb("raw_data").notNull(),
  mappedName: varchar("mapped_name", { length: 500 }),
  mappedStage: varchar("mapped_stage", { length: 100 }),
  mappedRepEmail: varchar("mapped_rep_email", { length: 255 }),
  mappedAmount: numeric("mapped_amount", { precision: 14, scale: 2 }),
  mappedCloseDate: date("mapped_close_date"),
  mappedSource: varchar("mapped_source", { length: 100 }),
  validationStatus: varchar("validation_status", { length: 50 }).default("pending").notNull(),
  validationErrors: jsonb("validation_errors").default([]).notNull(),
  validationWarnings: jsonb("validation_warnings").default([]).notNull(),
  reviewedBy: uuid("reviewed_by"),
  reviewNotes: text("review_notes"),
  promotedAt: timestamp("promoted_at", { withTimezone: true }),
  promotedDealId: uuid("promoted_deal_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("staged_deals_office_id_idx").on(table.officeId),
]);
