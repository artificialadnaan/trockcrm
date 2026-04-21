import {
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { estimateExtractionMatches } from "./estimate-extractions.js";
import { estimateLineItems } from "./estimate-line-items.js";
import { estimateSourceDocuments } from "./estimate-source-documents.js";
import { estimateExtractions, estimateGenerationRuns } from "./estimate-extractions.js";

export const estimatePricingRecommendations = pgTable(
  "estimate_pricing_recommendations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dealId: uuid("deal_id").notNull(),
    projectId: uuid("project_id"),
    extractionMatchId: uuid("extraction_match_id")
      .references(() => estimateExtractionMatches.id, { onDelete: "cascade" })
      .notNull(),
    sourceDocumentId: uuid("source_document_id").references(() => estimateSourceDocuments.id, {
      onDelete: "set null",
    }),
    sourceExtractionId: uuid("source_extraction_id").references(() => estimateExtractions.id, {
      onDelete: "set null",
    }),
    sourceType: text("source_type").default("extracted").notNull(),
    normalizedIntent: text("normalized_intent").notNull(),
    sourceRowIdentity: text("source_row_identity").notNull(),
    createdByRunId: uuid("generation_run_id")
      .references(() => estimateGenerationRuns.id, { onDelete: "cascade" })
      .notNull(),
    manualOrigin: text("manual_origin"),
    selectedSourceType: text("selected_source_type"),
    selectedOptionId: uuid("selected_option_id"),
    catalogBacking: text("catalog_backing"),
    promotedLocalCatalogItemId: uuid("promoted_local_catalog_item_id"),
    promotedEstimateLineItemId: uuid("promoted_estimate_line_item_id").references(
      () => estimateLineItems.id,
      { onDelete: "set null" }
    ),
    manualLabel: text("manual_label"),
    manualIdentityKey: text("manual_identity_key"),
    manualQuantity: numeric("manual_quantity", { precision: 14, scale: 3 }),
    manualUnit: varchar("manual_unit", { length: 50 }),
    manualUnitPrice: numeric("manual_unit_price", { precision: 14, scale: 2 }),
    manualNotes: text("manual_notes"),
    overrideQuantity: numeric("override_quantity", { precision: 14, scale: 3 }),
    overrideUnit: varchar("override_unit", { length: 50 }),
    overrideUnitPrice: numeric("override_unit_price", { precision: 14, scale: 2 }),
    overrideNotes: text("override_notes"),
    recommendedQuantity: numeric("recommended_quantity", { precision: 14, scale: 3 }),
    recommendedUnit: varchar("recommended_unit", { length: 50 }),
    recommendedUnitPrice: numeric("recommended_unit_price", { precision: 14, scale: 2 }),
    recommendedTotalPrice: numeric("recommended_total_price", { precision: 14, scale: 2 }),
    priceBasis: text("price_basis").notNull(),
    catalogBaselinePrice: numeric("catalog_baseline_price", { precision: 14, scale: 2 }),
    historicalMedianPrice: numeric("historical_median_price", { precision: 14, scale: 2 }),
    marketAdjustmentPercent: numeric("market_adjustment_percent", { precision: 8, scale: 3 })
      .default("0")
      .notNull(),
    confidence: numeric("confidence", { precision: 5, scale: 2 }).default("0").notNull(),
    assumptionsJson: jsonb("assumptions_json").default({}).notNull(),
    evidenceJson: jsonb("evidence_json").default({}).notNull(),
    status: text("status").default("pending").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("estimate_pricing_recommendations_match_idx").on(table.extractionMatchId, table.status),
    index("estimate_pricing_recommendations_run_idx").on(table.createdByRunId),
    unique("estimate_pricing_recommendations_run_source_uidx").on(
      table.createdByRunId,
      table.sourceRowIdentity
    ),
  ]
);
