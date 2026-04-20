import { index, jsonb, numeric, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { estimateDocumentPages, estimateSourceDocuments } from "./estimate-source-documents.js";
import { estimateLineItems } from "./estimate-line-items.js";

export const estimateGenerationRuns = pgTable(
  "estimate_generation_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dealId: uuid("deal_id").notNull(),
    projectId: uuid("project_id"),
    status: text("status").default("pending").notNull(),
    triggeredByUserId: uuid("triggered_by_user_id"),
    inputSnapshotJson: jsonb("input_snapshot_json").default({}).notNull(),
    outputSummaryJson: jsonb("output_summary_json").default({}).notNull(),
    errorSummary: text("error_summary"),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    catalogSyncRunId: uuid("catalog_sync_run_id"),
    catalogSnapshotVersionId: uuid("catalog_snapshot_version_id"),
  },
  (table) => [index("estimate_generation_runs_deal_idx").on(table.dealId, table.startedAt)]
);

export const estimateExtractions = pgTable(
  "estimate_extractions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dealId: uuid("deal_id").notNull(),
    projectId: uuid("project_id"),
    documentId: uuid("document_id")
      .references(() => estimateSourceDocuments.id, { onDelete: "cascade" })
      .notNull(),
    pageId: uuid("page_id").references(() => estimateDocumentPages.id, { onDelete: "set null" }),
    extractionType: text("extraction_type").notNull(),
    rawLabel: text("raw_label").notNull(),
    normalizedLabel: text("normalized_label").notNull(),
    quantity: numeric("quantity", { precision: 14, scale: 3 }),
    unit: varchar("unit", { length: 50 }),
    divisionHint: text("division_hint"),
    confidence: numeric("confidence", { precision: 5, scale: 2 }).default("0").notNull(),
    evidenceText: text("evidence_text"),
    evidenceBboxJson: jsonb("evidence_bbox_json").default({}).notNull(),
    metadataJson: jsonb("metadata_json").default({}).notNull(),
    status: text("status").default("pending").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("estimate_extractions_document_idx").on(table.documentId, table.createdAt),
    index("estimate_extractions_deal_idx").on(table.dealId, table.status),
  ]
);

export const estimateExtractionMatches = pgTable(
  "estimate_extraction_matches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    extractionId: uuid("extraction_id")
      .references(() => estimateExtractions.id, { onDelete: "cascade" })
      .notNull(),
    catalogItemId: uuid("catalog_item_id"),
    catalogCodeId: uuid("catalog_code_id"),
    historicalLineItemId: uuid("historical_line_item_id").references(() => estimateLineItems.id, {
      onDelete: "set null",
    }),
    matchType: text("match_type").notNull(),
    matchScore: numeric("match_score", { precision: 5, scale: 2 }).default("0").notNull(),
    status: text("status").default("suggested").notNull(),
    reasonJson: jsonb("reason_json").default({}).notNull(),
    evidenceJson: jsonb("evidence_json").default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("estimate_extraction_matches_extraction_idx").on(table.extractionId, table.status)]
);

export const estimatePricingRecommendations = pgTable(
  "estimate_pricing_recommendations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dealId: uuid("deal_id").notNull(),
    projectId: uuid("project_id"),
    extractionMatchId: uuid("extraction_match_id")
      .references(() => estimateExtractionMatches.id, { onDelete: "cascade" })
      .notNull(),
    recommendedQuantity: numeric("recommended_quantity", { precision: 14, scale: 3 }),
    recommendedUnit: varchar("recommended_unit", { length: 50 }),
    recommendedUnitPrice: numeric("recommended_unit_price", { precision: 14, scale: 2 }),
    recommendedTotalPrice: numeric("recommended_total_price", { precision: 14, scale: 2 }),
    priceBasis: text("price_basis").notNull(),
    catalogBaselinePrice: numeric("catalog_baseline_price", { precision: 14, scale: 2 }),
    historicalMedianPrice: numeric("historical_median_price", { precision: 14, scale: 2 }),
    marketAdjustmentPercent: numeric("market_adjustment_percent", { precision: 8, scale: 3 }).default("0").notNull(),
    confidence: numeric("confidence", { precision: 5, scale: 2 }).default("0").notNull(),
    assumptionsJson: jsonb("assumptions_json").default({}).notNull(),
    evidenceJson: jsonb("evidence_json").default({}).notNull(),
    createdByRunId: uuid("created_by_run_id").references(() => estimateGenerationRuns.id, {
      onDelete: "set null",
    }),
    status: text("status").default("pending").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("estimate_pricing_recommendations_match_idx").on(table.extractionMatchId, table.status),
    index("estimate_pricing_recommendations_run_idx").on(table.createdByRunId),
  ]
);

export const estimateReviewEvents = pgTable(
  "estimate_review_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dealId: uuid("deal_id").notNull(),
    projectId: uuid("project_id"),
    subjectType: text("subject_type").notNull(),
    subjectId: uuid("subject_id").notNull(),
    eventType: text("event_type").notNull(),
    beforeJson: jsonb("before_json").default({}).notNull(),
    afterJson: jsonb("after_json").default({}).notNull(),
    reason: text("reason"),
    userId: uuid("user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("estimate_review_events_deal_idx").on(table.dealId, table.createdAt),
    index("estimate_review_events_subject_idx").on(table.subjectType, table.subjectId),
  ]
);
