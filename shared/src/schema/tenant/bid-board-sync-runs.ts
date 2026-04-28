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
    status: text("status").default("received").notNull(),
    errors: jsonb("errors").$type<string[]>().default([]).notNull(),
    warnings: jsonb("warnings").$type<string[]>().default([]).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("bid_board_sync_runs_created_idx").on(table.createdAt),
    index("bid_board_sync_runs_payload_hash_idx").on(table.payloadHash),
  ]
);
