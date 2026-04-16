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

export const stagedActivities = migrationSchema.table("staged_activities", {
  id: uuid("id").primaryKey().defaultRandom(),
  officeId: uuid("office_id"),
  importRunId: uuid("import_run_id"),
  hubspotActivityId: varchar("hubspot_activity_id", { length: 100 }).unique().notNull(),
  hubspotDealId: varchar("hubspot_deal_id", { length: 100 }),
  hubspotDealIds: jsonb("hubspot_deal_ids").default([]).notNull(),
  hubspotContactId: varchar("hubspot_contact_id", { length: 100 }),
  hubspotContactIds: jsonb("hubspot_contact_ids").default([]).notNull(),
  rawData: jsonb("raw_data").notNull(),
  mappedType: varchar("mapped_type", { length: 50 }),
  mappedSubject: text("mapped_subject"),
  mappedBody: text("mapped_body"),
  mappedOccurredAt: timestamp("mapped_occurred_at", { withTimezone: true }),
  validationStatus: varchar("validation_status", { length: 50 }).default("pending").notNull(),
  validationErrors: jsonb("validation_errors").default([]).notNull(),
  promotedAt: timestamp("promoted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("staged_activities_office_id_idx").on(table.officeId),
]);
