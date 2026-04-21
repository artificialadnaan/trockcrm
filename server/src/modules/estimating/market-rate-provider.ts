import { and, eq, gte, isNull, lte, or } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import {
  estimateDealMarketOverrides,
  estimateMarketAdjustmentRules,
  estimateMarketFallbackGeographies,
  estimateMarketZipMappings,
  estimateMarkets,
} from "@trock-crm/shared/schema";

type TenantDb = NodePgDatabase<typeof schema>;

export type MarketIdentity = typeof estimateMarkets.$inferSelect;
export type MarketAdjustmentRuleRecord = typeof estimateMarketAdjustmentRules.$inferSelect;
export type MarketResolutionType = "global" | "metro" | "state" | "region";
export type PricingScopeType = "division" | "trade" | "general";

const pricingScopeOrder: PricingScopeType[] = ["general", "division", "trade"];

export interface MarketRateProviderTables {
  estimateDealMarketOverrides: typeof estimateDealMarketOverrides;
  estimateMarketAdjustmentRules: typeof estimateMarketAdjustmentRules;
  estimateMarketFallbackGeographies: typeof estimateMarketFallbackGeographies;
  estimateMarketZipMappings: typeof estimateMarketZipMappings;
  estimateMarkets: typeof estimateMarkets;
}

const defaultTables: MarketRateProviderTables = {
  estimateDealMarketOverrides,
  estimateMarketAdjustmentRules,
  estimateMarketFallbackGeographies,
  estimateMarketZipMappings,
  estimateMarkets,
};

export interface MarketRateProvider {
  findDealMarketOverride(dealId: string): Promise<MarketIdentity | null>;
  findMarketByZip(zip: string): Promise<MarketIdentity | null>;
  findMarketByFallbackGeography(input: {
    resolutionType: MarketResolutionType;
    resolutionKey: string;
  }): Promise<MarketIdentity | null>;
  getDefaultMarket(): Promise<MarketIdentity | null>;
  listMarketAdjustmentRules(input: {
    marketId: string | null;
    pricingScopeType: PricingScopeType;
    pricingScopeKey: string;
    asOf: Date;
  }): Promise<MarketAdjustmentRuleRecord[]>;
}

function normalizeZip(zip: string) {
  return zip.trim();
}

export function getPricingScopeRank(scopeType: PricingScopeType) {
  return pricingScopeOrder.indexOf(scopeType);
}

export function isPricingScopeBroadEnough(
  candidateScopeType: PricingScopeType,
  requestedScopeType: PricingScopeType
) {
  return getPricingScopeRank(candidateScopeType) <= getPricingScopeRank(requestedScopeType);
}

export function getAllowedPricingScopeTypes(requestedScopeType: PricingScopeType) {
  return pricingScopeOrder.filter((scopeType) =>
    isPricingScopeBroadEnough(scopeType, requestedScopeType)
  );
}

function buildPricingScopeCandidateFilter(input: {
  pricingScopeType: PricingScopeType;
  pricingScopeKey: string;
  estimateMarketAdjustmentRulesTable: MarketRateProviderTables["estimateMarketAdjustmentRules"];
}) {
  const allowedScopeTypes = getAllowedPricingScopeTypes(input.pricingScopeType);

  return or(
    and(
      eq(input.estimateMarketAdjustmentRulesTable.scopeType, input.pricingScopeType),
      eq(input.estimateMarketAdjustmentRulesTable.scopeKey, input.pricingScopeKey)
    ),
    ...allowedScopeTypes.map((scopeType) =>
      and(
        eq(input.estimateMarketAdjustmentRulesTable.scopeType, scopeType),
        eq(input.estimateMarketAdjustmentRulesTable.fallbackScopeType, input.pricingScopeType),
        eq(input.estimateMarketAdjustmentRulesTable.fallbackScopeKey, input.pricingScopeKey)
      )
    ),
    and(
      eq(input.estimateMarketAdjustmentRulesTable.scopeType, "general"),
      eq(input.estimateMarketAdjustmentRulesTable.scopeKey, "default")
    ),
    and(
      eq(input.estimateMarketAdjustmentRulesTable.fallbackScopeType, "general"),
      eq(input.estimateMarketAdjustmentRulesTable.fallbackScopeKey, "default")
    )
  );
}

function mapMarketIdentity(row: typeof estimateMarkets.$inferSelect | null | undefined): MarketIdentity | null {
  return row
    ? {
        id: row.id,
        name: row.name,
        slug: row.slug,
        type: row.type,
        stateCode: row.stateCode,
        regionId: row.regionId,
        isActive: row.isActive,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }
    : null;
}

export function createMarketRateProvider(
  tenantDb: TenantDb,
  tables: MarketRateProviderTables = defaultTables
): MarketRateProvider {
  return {
    async findDealMarketOverride(dealId: string) {
      const [row] = await tenantDb
        .select({
          id: tables.estimateMarkets.id,
          name: tables.estimateMarkets.name,
          slug: tables.estimateMarkets.slug,
          type: tables.estimateMarkets.type,
          stateCode: tables.estimateMarkets.stateCode,
          regionId: tables.estimateMarkets.regionId,
          isActive: tables.estimateMarkets.isActive,
          createdAt: tables.estimateMarkets.createdAt,
          updatedAt: tables.estimateMarkets.updatedAt,
        })
        .from(tables.estimateDealMarketOverrides)
        .innerJoin(tables.estimateMarkets, eq(tables.estimateDealMarketOverrides.marketId, tables.estimateMarkets.id))
        .where(
          and(
            eq(tables.estimateDealMarketOverrides.dealId, dealId),
            eq(tables.estimateDealMarketOverrides.marketId, tables.estimateMarkets.id),
            eq(tables.estimateMarkets.isActive, true)
          )
        )
        .limit(1);

      return mapMarketIdentity(row);
    },

    async findMarketByZip(zip: string) {
      const [row] = await tenantDb
        .select({
          id: tables.estimateMarkets.id,
          name: tables.estimateMarkets.name,
          slug: tables.estimateMarkets.slug,
          type: tables.estimateMarkets.type,
          stateCode: tables.estimateMarkets.stateCode,
          regionId: tables.estimateMarkets.regionId,
          isActive: tables.estimateMarkets.isActive,
          createdAt: tables.estimateMarkets.createdAt,
          updatedAt: tables.estimateMarkets.updatedAt,
        })
        .from(tables.estimateMarketZipMappings)
        .innerJoin(tables.estimateMarkets, eq(tables.estimateMarketZipMappings.marketId, tables.estimateMarkets.id))
        .where(
          and(
            eq(tables.estimateMarketZipMappings.zip, normalizeZip(zip)),
            eq(tables.estimateMarketZipMappings.isActive, true),
            eq(tables.estimateMarkets.isActive, true)
          )
        )
        .limit(1);

      return mapMarketIdentity(row);
    },

    async findMarketByFallbackGeography(input) {
      const [row] = await tenantDb
        .select({
          id: tables.estimateMarkets.id,
          name: tables.estimateMarkets.name,
          slug: tables.estimateMarkets.slug,
          type: tables.estimateMarkets.type,
          stateCode: tables.estimateMarkets.stateCode,
          regionId: tables.estimateMarkets.regionId,
          isActive: tables.estimateMarkets.isActive,
          createdAt: tables.estimateMarkets.createdAt,
          updatedAt: tables.estimateMarkets.updatedAt,
        })
        .from(tables.estimateMarketFallbackGeographies)
        .innerJoin(
          tables.estimateMarkets,
          eq(tables.estimateMarketFallbackGeographies.marketId, tables.estimateMarkets.id)
        )
        .where(
          and(
            eq(tables.estimateMarketFallbackGeographies.resolutionType, input.resolutionType),
            eq(tables.estimateMarketFallbackGeographies.resolutionKey, input.resolutionKey),
            eq(tables.estimateMarketFallbackGeographies.isActive, true),
            eq(tables.estimateMarkets.isActive, true)
          )
        )
        .limit(1);

      return mapMarketIdentity(row);
    },

    async getDefaultMarket() {
      return tenantDb
        .select({
          id: tables.estimateMarkets.id,
          name: tables.estimateMarkets.name,
          slug: tables.estimateMarkets.slug,
          type: tables.estimateMarkets.type,
          stateCode: tables.estimateMarkets.stateCode,
          regionId: tables.estimateMarkets.regionId,
          isActive: tables.estimateMarkets.isActive,
          createdAt: tables.estimateMarkets.createdAt,
          updatedAt: tables.estimateMarkets.updatedAt,
        })
        .from(tables.estimateMarketFallbackGeographies)
        .innerJoin(
          tables.estimateMarkets,
          eq(tables.estimateMarketFallbackGeographies.marketId, tables.estimateMarkets.id)
        )
        .where(
          and(
            eq(tables.estimateMarketFallbackGeographies.resolutionType, "global"),
            eq(tables.estimateMarketFallbackGeographies.resolutionKey, "default"),
            eq(tables.estimateMarketFallbackGeographies.isActive, true),
            eq(tables.estimateMarkets.isActive, true)
          )
        )
        .limit(1)
        .then(([row]) => mapMarketIdentity(row));
    },

    async listMarketAdjustmentRules(input) {
      const marketFilter = input.marketId
        ? or(
            isNull(tables.estimateMarketAdjustmentRules.marketId),
            eq(tables.estimateMarketAdjustmentRules.marketId, input.marketId)
          )
        : isNull(tables.estimateMarketAdjustmentRules.marketId);

      return tenantDb
        .select()
        .from(tables.estimateMarketAdjustmentRules)
        .where(
          and(
            eq(tables.estimateMarketAdjustmentRules.isActive, true),
            lte(tables.estimateMarketAdjustmentRules.effectiveFrom, input.asOf),
            or(
              isNull(tables.estimateMarketAdjustmentRules.effectiveTo),
              gte(tables.estimateMarketAdjustmentRules.effectiveTo, input.asOf)
            ),
            marketFilter,
            buildPricingScopeCandidateFilter({
              pricingScopeType: input.pricingScopeType,
              pricingScopeKey: input.pricingScopeKey,
              estimateMarketAdjustmentRulesTable: tables.estimateMarketAdjustmentRules,
            })
          )
        );
    },
  };
}
