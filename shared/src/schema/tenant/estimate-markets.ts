import {
  boolean,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { regionConfig } from "../public/region-config.js";
import { users } from "../public/users.js";

export const estimateMarkets = pgTable(
  "estimate_markets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: varchar("name", { length: 255 }).notNull(),
    slug: varchar("slug", { length: 100 }).notNull(),
    type: varchar("type", { length: 32 }).notNull(),
    stateCode: varchar("state_code", { length: 2 }),
    regionId: uuid("region_id").references(() => regionConfig.id, { onDelete: "set null" }),
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("estimate_markets_slug_uidx").on(table.slug),
    index("estimate_markets_type_idx").on(table.type, table.isActive),
    index("estimate_markets_state_idx").on(table.stateCode, table.isActive),
    index("estimate_markets_region_idx").on(table.regionId, table.isActive),
    index("estimate_markets_active_idx").on(table.isActive),
  ]
);

export const estimateMarketZipMappings = pgTable(
  "estimate_market_zip_mappings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    zip: varchar("zip", { length: 10 }).notNull(),
    marketId: uuid("market_id")
      .references(() => estimateMarkets.id, { onDelete: "cascade" })
      .notNull(),
    sourceType: text("source_type").default("manual").notNull(),
    sourceConfidence: numeric("source_confidence", { precision: 5, scale: 2 })
      .default("1")
      .notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("estimate_market_zip_mappings_zip_uidx").on(table.zip),
    index("estimate_market_zip_mappings_market_idx").on(table.marketId, table.isActive),
  ]
);

export const estimateMarketFallbackGeographies = pgTable(
  "estimate_market_fallback_geographies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    marketId: uuid("market_id")
      .references(() => estimateMarkets.id, { onDelete: "cascade" })
      .notNull(),
    resolutionType: varchar("resolution_type", { length: 32 }).notNull(),
    resolutionKey: varchar("resolution_key", { length: 120 }).notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("estimate_market_fallback_geographies_scope_uidx").on(
      table.resolutionType,
      table.resolutionKey
    ),
    index("estimate_market_fallback_geographies_market_idx").on(table.marketId, table.isActive),
  ]
);

export const estimateMarketAdjustmentRules = pgTable(
  "estimate_market_adjustment_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    marketId: uuid("market_id").references(() => estimateMarkets.id, { onDelete: "cascade" }),
    scopeType: varchar("scope_type", { length: 32 }).notNull(),
    scopeKey: varchar("scope_key", { length: 120 }).notNull(),
    fallbackScopeType: varchar("fallback_scope_type", { length: 32 }),
    fallbackScopeKey: varchar("fallback_scope_key", { length: 120 }),
    priority: integer("priority").default(0).notNull(),
    fallbackPriority: integer("fallback_priority").default(0).notNull(),
    laborAdjustmentPercent: numeric("labor_adjustment_percent", { precision: 8, scale: 3 })
      .default("0")
      .notNull(),
    materialAdjustmentPercent: numeric("material_adjustment_percent", { precision: 8, scale: 3 })
      .default("0")
      .notNull(),
    equipmentAdjustmentPercent: numeric("equipment_adjustment_percent", { precision: 8, scale: 3 })
      .default("0")
      .notNull(),
    defaultLaborWeight: numeric("default_labor_weight", { precision: 8, scale: 4 })
      .default("0.3333")
      .notNull(),
    defaultMaterialWeight: numeric("default_material_weight", { precision: 8, scale: 4 })
      .default("0.3333")
      .notNull(),
    defaultEquipmentWeight: numeric("default_equipment_weight", { precision: 8, scale: 4 })
      .default("0.3334")
      .notNull(),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).defaultNow().notNull(),
    effectiveTo: timestamp("effective_to", { withTimezone: true }),
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("estimate_market_adjustment_rules_market_scope_uidx")
      .on(table.marketId, table.scopeType, table.scopeKey, table.effectiveFrom)
      .where(sql`${table.marketId} is not null`),
    uniqueIndex("estimate_market_adjustment_rules_default_scope_uidx")
      .on(table.scopeType, table.scopeKey, table.effectiveFrom)
      .where(sql`${table.marketId} is null`),
    index("estimate_market_adjustment_rules_selection_idx").on(
      table.marketId,
      table.scopeType,
      table.scopeKey,
      table.priority,
      table.fallbackPriority,
      table.isActive,
      table.effectiveFrom,
      table.effectiveTo
    ),
    index("estimate_market_adjustment_rules_fallback_idx").on(
      table.fallbackScopeType,
      table.fallbackScopeKey,
      table.fallbackPriority
    ),
  ]
);

export const estimateDealMarketOverrides = pgTable(
  "estimate_deal_market_overrides",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dealId: uuid("deal_id").notNull(),
    marketId: uuid("market_id")
      .references(() => estimateMarkets.id, { onDelete: "cascade" })
      .notNull(),
    overriddenByUserId: uuid("overridden_by_user_id").references(() => users.id).notNull(),
    overrideReason: text("override_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("estimate_deal_market_overrides_deal_uidx").on(table.dealId),
    index("estimate_deal_market_overrides_deal_idx").on(table.dealId, table.updatedAt),
    index("estimate_deal_market_overrides_market_idx").on(table.marketId, table.createdAt),
  ]
);
