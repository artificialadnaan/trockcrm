import { integer, jsonb, pgTable, text, timestamp, uuid, index } from "drizzle-orm/pg-core";

export const bidBoardSyncRuns = pgTable(
  "bid_board_sync_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceFilename: text("source_filename"),
    extractedAt: timestamp("extracted_at", { withTimezone: true }),
    payloadHash: text("payload_hash").notNull(),
    rowCount: integer("row_count").default(0).notNull(),
    updatedCount: integer("updated_count").default(0).notNull(),
    noMatchCount: integer("no_match_count").default(0).notNull(),
    multiMatchCount: integer("multi_match_count").default(0).notNull(),
    warningCount: integer("warning_count").default(0).notNull(),
    matchedCount: integer("matched_count").default(0).notNull(),
    stageUpdatedCount: integer("stage_updated_count").default(0).notNull(),
    skippedNoProjectNumberCount: integer("skipped_no_project_number_count").default(0).notNull(),
    skippedUnmappedStatusCount: integer("skipped_unmapped_status_count").default(0).notNull(),
    skippedTemplateCount: integer("skipped_template_count").default(0).notNull(),
    // Legacy: retained for historical run rows. The Bid Board export is now authoritative on
    // backward stage moves, so backward syncs are APPLIED (applied_backward_count) rather than
    // skipped. New runs leave this at 0; appliedBackwardCount is the live counter.
    skippedBackwardCount: integer("skipped_backward_count").default(0).notNull(),
    appliedBackwardCount: integer("applied_backward_count").default(0).notNull(),
    skippedTerminalCount: integer("skipped_terminal_count").default(0).notNull(),
    skippedNoStageChangeCount: integer("skipped_no_stage_change_count").default(0).notNull(),
    // Rows whose CRM deal exists but has been DETACHED from Bid Board ("Move back to Opportunity",
    // migration 0200). Counted separately from no_match_count on purpose: folding them into noMatch
    // would flip EVERY subsequent run to 'completed_with_unmatched' and append the same project number
    // to unmatched_project_numbers forever, burying the real "a deal silently failed to sync" signal.
    skippedDetachedCount: integer("skipped_detached_count").default(0).notNull(),
    estimateUpdatedCount: integer("estimate_updated_count").default(0).notNull(),
    estimateUpdatedHigherCount: integer("estimate_updated_higher_count").default(0).notNull(),
    estimateUpdatedLowerCount: integer("estimate_updated_lower_count").default(0).notNull(),
    estimateSkippedNoValueCount: integer("estimate_skipped_no_value_count").default(0).notNull(),
    estimateSkippedNoChangeCount: integer("estimate_skipped_no_change_count").default(0).notNull(),
    estimateSkippedTerminalCount: integer("estimate_skipped_terminal_count").default(0).notNull(),
    estimateWarningCount: integer("estimate_warning_count").default(0).notNull(),
    status: text("status").default("received").notNull(),
    errors: jsonb("errors").$type<string[]>().default([]).notNull(),
    warnings: jsonb("warnings").$type<string[]>().default([]).notNull(),
    unmatchedProjectNumbers: jsonb("unmatched_project_numbers").$type<string[]>().default([]).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("bid_board_sync_runs_created_idx").on(table.createdAt),
    index("bid_board_sync_runs_payload_hash_idx").on(table.payloadHash),
  ]
);
