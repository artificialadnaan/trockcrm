import {
  boolean,
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
import { costCatalogSnapshotVersions, costCatalogSources, costCatalogSyncRuns } from "./cost-catalog-sources.js";

export const costCatalogCodes = pgTable(
  "cost_catalog_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceId: uuid("source_id")
      .references(() => costCatalogSources.id, { onDelete: "cascade" })
      .notNull(),
    snapshotVersionId: uuid("snapshot_version_id").references(() => costCatalogSnapshotVersions.id, {
      onDelete: "set null",
    }),
    externalId: text("external_id").notNull(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    parentCodeId: uuid("parent_code_id"),
    division: text("division"),
    phaseName: text("phase_name"),
    phaseCode: text("phase_code"),
    isActive: boolean("is_active").default(true).notNull(),
    metadataJson: jsonb("metadata_json").default({}).notNull(),
  },
  (table) => [
    unique().on(table.sourceId, table.externalId),
    index("cost_catalog_codes_code_idx").on(table.sourceId, table.code),
  ]
);

export const costCatalogItems = pgTable(
  "cost_catalog_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceId: uuid("source_id")
      .references(() => costCatalogSources.id, { onDelete: "cascade" })
      .notNull(),
    snapshotVersionId: uuid("snapshot_version_id").references(() => costCatalogSnapshotVersions.id, {
      onDelete: "set null",
    }),
    externalId: text("external_id").notNull(),
    itemType: text("item_type").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    unit: varchar("unit", { length: 50 }),
    catalogName: text("catalog_name"),
    catalogNumber: text("catalog_number"),
    manufacturer: text("manufacturer"),
    supplier: text("supplier"),
    taxable: boolean("taxable").default(false).notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    metadataJson: jsonb("metadata_json").default({}).notNull(),
  },
  (table) => [
    unique().on(table.sourceId, table.externalId),
    index("cost_catalog_items_name_idx").on(table.sourceId, table.name),
  ]
);

export const costCatalogItemCodes = pgTable(
  "cost_catalog_item_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    catalogItemId: uuid("catalog_item_id")
      .references(() => costCatalogItems.id, { onDelete: "cascade" })
      .notNull(),
    catalogCodeId: uuid("catalog_code_id")
      .references(() => costCatalogCodes.id, { onDelete: "cascade" })
      .notNull(),
    isPrimary: boolean("is_primary").default(false).notNull(),
  },
  (table) => [
    unique().on(table.catalogItemId, table.catalogCodeId),
    index("cost_catalog_item_codes_primary_idx").on(table.catalogItemId, table.isPrimary),
  ]
);

export const costCatalogPrices = pgTable(
  "cost_catalog_prices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    catalogItemId: uuid("catalog_item_id")
      .references(() => costCatalogItems.id, { onDelete: "cascade" })
      .notNull(),
    sourceId: uuid("source_id")
      .references(() => costCatalogSources.id, { onDelete: "cascade" })
      .notNull(),
    syncRunId: uuid("sync_run_id").references(() => costCatalogSyncRuns.id, { onDelete: "set null" }),
    snapshotVersionId: uuid("snapshot_version_id").references(() => costCatalogSnapshotVersions.id, {
      onDelete: "set null",
    }),
    materialUnitCost: numeric("material_unit_cost", { precision: 14, scale: 2 }),
    laborUnitCost: numeric("labor_unit_cost", { precision: 14, scale: 2 }),
    equipmentUnitCost: numeric("equipment_unit_cost", { precision: 14, scale: 2 }),
    subcontractUnitCost: numeric("subcontract_unit_cost", { precision: 14, scale: 2 }),
    blendedUnitCost: numeric("blended_unit_cost", { precision: 14, scale: 2 }),
    effectiveAt: timestamp("effective_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    metadataJson: jsonb("metadata_json").default({}).notNull(),
  },
  (table) => [
    index("cost_catalog_prices_item_idx").on(table.catalogItemId, table.effectiveAt),
    index("cost_catalog_prices_snapshot_idx").on(table.snapshotVersionId),
  ]
);
