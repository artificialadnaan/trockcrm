import { index, jsonb, pgTable, text, timestamp, uuid, uniqueIndex } from "drizzle-orm/pg-core";

export const hubspotActivityBackfillLedger = pgTable(
  "hubspot_activity_backfill_ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantSchema: text("tenant_schema").notNull(),
    hubspotObjectType: text("hubspot_object_type").notNull(),
    hubspotObjectId: text("hubspot_object_id").notNull(),
    targetEntityType: text("target_entity_type"),
    targetEntityId: uuid("target_entity_id"),
    importedAt: timestamp("imported_at", { withTimezone: true }).defaultNow().notNull(),
    activityId: uuid("activity_id"),
    emailId: uuid("email_id"),
    status: text("status").notNull(),
    skipReason: text("skip_reason"),
    sourcePayload: jsonb("source_payload"),
  },
  (table) => [
    uniqueIndex("hubspot_activity_backfill_ledger_tenant_object_uidx").on(
      table.tenantSchema,
      table.hubspotObjectType,
      table.hubspotObjectId
    ),
    index("hubspot_activity_backfill_ledger_tenant_status_idx").on(table.tenantSchema, table.status),
  ]
);
