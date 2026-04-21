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

export function createMarketRateProvider(tenantDb: TenantDb): MarketRateProvider {
  return {
    async findDealMarketOverride(dealId: string) {
      const [row] = await tenantDb
        .select({
          id: estimateMarkets.id,
          name: estimateMarkets.name,
          slug: estimateMarkets.slug,
          type: estimateMarkets.type,
          stateCode: estimateMarkets.stateCode,
          regionId: estimateMarkets.regionId,
          isActive: estimateMarkets.isActive,
          createdAt: estimateMarkets.createdAt,
          updatedAt: estimateMarkets.updatedAt,
        })
        .from(estimateDealMarketOverrides)
        .innerJoin(estimateMarkets, eq(estimateDealMarketOverrides.marketId, estimateMarkets.id))
        .where(
          and(
            eq(estimateDealMarketOverrides.dealId, dealId),
            eq(estimateDealMarketOverrides.marketId, estimateMarkets.id),
            eq(estimateMarkets.isActive, true)
          )
        )
        .limit(1);

      return mapMarketIdentity(row);
    },

    async findMarketByZip(zip: string) {
      const [row] = await tenantDb
        .select({
          id: estimateMarkets.id,
          name: estimateMarkets.name,
          slug: estimateMarkets.slug,
          type: estimateMarkets.type,
          stateCode: estimateMarkets.stateCode,
          regionId: estimateMarkets.regionId,
          isActive: estimateMarkets.isActive,
          createdAt: estimateMarkets.createdAt,
          updatedAt: estimateMarkets.updatedAt,
        })
        .from(estimateMarketZipMappings)
        .innerJoin(estimateMarkets, eq(estimateMarketZipMappings.marketId, estimateMarkets.id))
        .where(
          and(
            eq(estimateMarketZipMappings.zip, normalizeZip(zip)),
            eq(estimateMarketZipMappings.isActive, true),
            eq(estimateMarkets.isActive, true)
          )
        )
        .limit(1);

      return mapMarketIdentity(row);
    },

    async findMarketByFallbackGeography(input) {
      const [row] = await tenantDb
        .select({
          id: estimateMarkets.id,
          name: estimateMarkets.name,
          slug: estimateMarkets.slug,
          type: estimateMarkets.type,
          stateCode: estimateMarkets.stateCode,
          regionId: estimateMarkets.regionId,
          isActive: estimateMarkets.isActive,
          createdAt: estimateMarkets.createdAt,
          updatedAt: estimateMarkets.updatedAt,
        })
        .from(estimateMarketFallbackGeographies)
        .innerJoin(estimateMarkets, eq(estimateMarketFallbackGeographies.marketId, estimateMarkets.id))
        .where(
          and(
            eq(estimateMarketFallbackGeographies.resolutionType, input.resolutionType),
            eq(estimateMarketFallbackGeographies.resolutionKey, input.resolutionKey),
            eq(estimateMarketFallbackGeographies.isActive, true),
            eq(estimateMarkets.isActive, true)
          )
        )
        .limit(1);

      return mapMarketIdentity(row);
    },

    async getDefaultMarket() {
      return tenantDb
        .select({
          id: estimateMarkets.id,
          name: estimateMarkets.name,
          slug: estimateMarkets.slug,
          type: estimateMarkets.type,
          stateCode: estimateMarkets.stateCode,
          regionId: estimateMarkets.regionId,
          isActive: estimateMarkets.isActive,
          createdAt: estimateMarkets.createdAt,
          updatedAt: estimateMarkets.updatedAt,
        })
        .from(estimateMarketFallbackGeographies)
        .innerJoin(estimateMarkets, eq(estimateMarketFallbackGeographies.marketId, estimateMarkets.id))
        .where(
          and(
            eq(estimateMarketFallbackGeographies.resolutionType, "global"),
            eq(estimateMarketFallbackGeographies.resolutionKey, "default"),
            eq(estimateMarketFallbackGeographies.isActive, true),
            eq(estimateMarkets.isActive, true)
          )
        )
        .limit(1)
        .then(([row]) => mapMarketIdentity(row));
    },

    async listMarketAdjustmentRules(input) {
      const marketFilter = input.marketId
        ? or(isNull(estimateMarketAdjustmentRules.marketId), eq(estimateMarketAdjustmentRules.marketId, input.marketId))
        : isNull(estimateMarketAdjustmentRules.marketId);

      return tenantDb
        .select()
        .from(estimateMarketAdjustmentRules)
        .where(
          and(
            eq(estimateMarketAdjustmentRules.isActive, true),
            lte(estimateMarketAdjustmentRules.effectiveFrom, input.asOf),
            or(
              isNull(estimateMarketAdjustmentRules.effectiveTo),
              gte(estimateMarketAdjustmentRules.effectiveTo, input.asOf)
            ),
            marketFilter,
            or(
              and(
                eq(estimateMarketAdjustmentRules.scopeType, input.pricingScopeType),
                eq(estimateMarketAdjustmentRules.scopeKey, input.pricingScopeKey)
              ),
              and(
                eq(estimateMarketAdjustmentRules.fallbackScopeType, input.pricingScopeType),
                eq(estimateMarketAdjustmentRules.fallbackScopeKey, input.pricingScopeKey)
              )
            )
          )
        );
    },
  };
}
