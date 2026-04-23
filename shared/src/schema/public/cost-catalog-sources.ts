import { index, pgTable, text, timestamp, uuid, varchar, jsonb, integer } from "drizzle-orm/pg-core";

export const costCatalogSources = pgTable(
  "cost_catalog_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: text("provider").notNull(),
    externalAccountId: text("external_account_id"),
    name: text("name").notNull(),
    status: text("status").default("active").notNull(),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    lastSuccessfulSyncAt: timestamp("last_successful_sync_at", { withTimezone: true }),
    defaultCurrency: varchar("default_currency", { length: 3 }).default("USD").notNull(),
    metadataJson: jsonb("metadata_json").default({}).notNull(),
  },
  (table) => [index("cost_catalog_sources_provider_idx").on(table.provider, table.status)]
);

export const costCatalogSyncRuns = pgTable(
  "cost_catalog_sync_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceId: uuid("source_id")
      .references(() => costCatalogSources.id, { onDelete: "cascade" })
      .notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    status: text("status").default("pending").notNull(),
    itemsSeen: integer("items_seen").default(0).notNull(),
    itemsUpserted: integer("items_upserted").default(0).notNull(),
    itemsDeactivated: integer("items_deactivated").default(0).notNull(),
    errorSummary: text("error_summary"),
    metadataJson: jsonb("metadata_json").default({}).notNull(),
  },
  (table) => [index("cost_catalog_sync_runs_source_idx").on(table.sourceId, table.startedAt)]
);

export const costCatalogSnapshotVersions = pgTable(
  "cost_catalog_snapshot_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceId: uuid("source_id")
      .references(() => costCatalogSources.id, { onDelete: "cascade" })
      .notNull(),
    syncRunId: uuid("sync_run_id")
      .references(() => costCatalogSyncRuns.id, { onDelete: "cascade" })
      .notNull(),
    status: text("status").default("staged").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    promotedAt: timestamp("promoted_at", { withTimezone: true }),
  },
  (table) => [index("cost_catalog_snapshot_versions_source_idx").on(table.sourceId, table.createdAt)]
);
