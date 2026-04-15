import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";

export const aiDocumentIndex = pgTable(
  "ai_document_index",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceType: varchar("source_type", { length: 64 }).notNull(),
    sourceId: uuid("source_id").notNull(),
    companyId: uuid("company_id"),
    propertyId: uuid("property_id"),
    leadId: uuid("lead_id"),
    dealId: uuid("deal_id"),
    indexStatus: varchar("index_status", { length: 32 }).default("pending").notNull(),
    contentHash: varchar("content_hash", { length: 128 }),
    metadataJson: jsonb("metadata_json"),
    indexedAt: timestamp("indexed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("ai_document_index_source_idx").on(table.sourceType, table.sourceId),
    index("ai_document_index_deal_idx").on(table.dealId, table.indexStatus),
  ]
);
