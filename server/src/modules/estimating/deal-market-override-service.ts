import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import {
  deals,
  estimateDealMarketOverrides,
  estimateMarkets,
  estimateReviewEvents,
  jobQueue,
  properties,
} from "@trock-crm/shared/schema";
import { AppError } from "../../middleware/error-handler.js";
import { createMarketRateProvider } from "./market-rate-provider.js";
import { resolveDealMarketLocation, resolveMarketContext } from "./market-resolution-service.js";

type TenantDb = NodePgDatabase<typeof schema>;

export interface DealMarketContextResult {
  effectiveMarket: Awaited<ReturnType<typeof resolveMarketContext>>["market"];
  resolutionLevel: Awaited<ReturnType<typeof resolveMarketContext>>["resolutionLevel"];
  resolutionSource: Awaited<ReturnType<typeof resolveMarketContext>>["resolutionSource"];
  location: ReturnType<typeof resolveDealMarketLocation>;
  override: {
    id: string;
    marketId: string;
    marketName: string;
    marketSlug: string;
    overriddenByUserId: string;
    overrideReason: string | null;
    createdAt: Date;
    updatedAt: Date;
  } | null;
}

async function loadDealLocation(tenantDb: TenantDb, dealId: string) {
  const [dealRow] = await tenantDb
    .select({
      id: deals.id,
      dealZip: deals.propertyZip,
      dealState: deals.propertyState,
      dealRegionId: deals.regionId,
      propertyId: deals.propertyId,
    })
    .from(deals)
    .where(eq(deals.id, dealId))
    .limit(1);

  if (!dealRow) {
    throw new AppError(404, "Deal not found");
  }

  let propertyLocation: { zip: string | null; state: string | null } | null = null;
  if (dealRow.propertyId && (!dealRow.dealZip || !dealRow.dealState)) {
    const [propertyRow] = await tenantDb
      .select({
        zip: properties.zip,
        state: properties.state,
      })
      .from(properties)
      .where(eq(properties.id, dealRow.propertyId))
      .limit(1);
    propertyLocation = propertyRow ?? null;
  }

  return {
    deal: dealRow,
    propertyLocation,
    location: resolveDealMarketLocation({
      dealZip: dealRow.dealZip,
      dealState: dealRow.dealState,
      dealRegionId: dealRow.dealRegionId,
      propertyZip: propertyLocation?.zip ?? null,
      propertyState: propertyLocation?.state ?? null,
      propertyRegionId: null,
    }),
  };
}

async function loadOverrideRow(tenantDb: TenantDb, dealId: string) {
  const [overrideRow] = await tenantDb
    .select({
      id: estimateDealMarketOverrides.id,
      marketId: estimateDealMarketOverrides.marketId,
      overriddenByUserId: estimateDealMarketOverrides.overriddenByUserId,
      overrideReason: estimateDealMarketOverrides.overrideReason,
      createdAt: estimateDealMarketOverrides.createdAt,
      updatedAt: estimateDealMarketOverrides.updatedAt,
      marketName: estimateMarkets.name,
      marketSlug: estimateMarkets.slug,
    })
    .from(estimateDealMarketOverrides)
    .innerJoin(estimateMarkets, eq(estimateDealMarketOverrides.marketId, estimateMarkets.id))
    .where(eq(estimateDealMarketOverrides.dealId, dealId))
    .limit(1);

  return overrideRow ?? null;
}

async function insertReviewEvent(args: {
  tenantDb: TenantDb;
  dealId: string;
  userId: string;
  eventType: "market_override_set" | "market_override_cleared";
  beforeJson: Record<string, unknown>;
  afterJson: Record<string, unknown>;
  reason?: string | null;
}) {
  const [reviewEvent] = await args.tenantDb
    .insert(estimateReviewEvents)
    .values({
      dealId: args.dealId,
      subjectType: "deal_market_override",
      subjectId: args.dealId,
      eventType: args.eventType,
      userId: args.userId,
      beforeJson: args.beforeJson,
      afterJson: args.afterJson,
      reason: args.reason ?? null,
    })
    .returning();

  return reviewEvent;
}

async function enqueueGenerationRerun(args: {
  tenantDb: TenantDb;
  officeId: string | null;
  dealId: string;
  rerunRequestId: string;
  reason: "market_override_set" | "market_override_cleared";
}) {
  await args.tenantDb.insert(jobQueue).values({
    jobType: "estimate_generation",
    officeId: args.officeId,
    status: "pending",
    runAfter: new Date(),
    payload: {
      dealId: args.dealId,
      officeId: args.officeId,
      rerunRequestId: args.rerunRequestId,
      trigger: "deal_market_override",
      reason: args.reason,
    },
  });
}

export async function listEstimateMarkets(tenantDb: TenantDb) {
  return tenantDb
    .select({
      id: estimateMarkets.id,
      name: estimateMarkets.name,
      slug: estimateMarkets.slug,
      type: estimateMarkets.type,
      stateCode: estimateMarkets.stateCode,
      regionId: estimateMarkets.regionId,
      isActive: estimateMarkets.isActive,
    })
    .from(estimateMarkets)
    .where(eq(estimateMarkets.isActive, true))
    .orderBy(estimateMarkets.type, estimateMarkets.name);
}

export async function getDealEffectiveMarketContext(
  tenantDb: TenantDb,
  dealId: string
): Promise<DealMarketContextResult> {
  const locationInput = await loadDealLocation(tenantDb, dealId);
  const provider = createMarketRateProvider(tenantDb);
  const resolved = await resolveMarketContext(provider, {
    dealId,
    dealZip: locationInput.deal.dealZip,
    dealState: locationInput.deal.dealState,
    dealRegionId: locationInput.deal.dealRegionId,
    propertyZip: locationInput.propertyLocation?.zip ?? null,
    propertyState: locationInput.propertyLocation?.state ?? null,
    propertyRegionId: null,
  });
  const overrideRow = await loadOverrideRow(tenantDb, dealId);

  return {
    effectiveMarket: resolved.market,
    resolutionLevel: resolved.resolutionLevel,
    resolutionSource: resolved.resolutionSource,
    location: resolved.location,
    override: overrideRow
      ? {
          id: overrideRow.id,
          marketId: overrideRow.marketId,
          marketName: overrideRow.marketName,
          marketSlug: overrideRow.marketSlug,
          overriddenByUserId: overrideRow.overriddenByUserId,
          overrideReason: overrideRow.overrideReason ?? null,
          createdAt: overrideRow.createdAt,
          updatedAt: overrideRow.updatedAt,
        }
      : null,
  };
}

export async function setDealMarketOverride(args: {
  tenantDb: TenantDb;
  dealId: string;
  marketId: string;
  userId: string;
  officeId: string | null;
  reason?: string | null;
}) {
  const [market] = await args.tenantDb
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
    .from(estimateMarkets)
    .where(and(eq(estimateMarkets.id, args.marketId), eq(estimateMarkets.isActive, true)))
    .limit(1);

  if (!market) {
    throw new AppError(404, "Estimate market not found");
  }

  const before = await getDealEffectiveMarketContext(args.tenantDb, args.dealId);
  const [override] = await args.tenantDb
    .insert(estimateDealMarketOverrides)
    .values({
      dealId: args.dealId,
      marketId: args.marketId,
      overriddenByUserId: args.userId,
      overrideReason: args.reason ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: estimateDealMarketOverrides.dealId,
      set: {
        marketId: args.marketId,
        overriddenByUserId: args.userId,
        overrideReason: args.reason ?? null,
        updatedAt: new Date(),
      },
    })
    .returning();

  const rerunRequestId = randomUUID();
  await enqueueGenerationRerun({
    tenantDb: args.tenantDb,
    officeId: args.officeId,
    dealId: args.dealId,
    rerunRequestId,
    reason: "market_override_set",
  });
  const effectiveMarket = await getDealEffectiveMarketContext(args.tenantDb, args.dealId);
  const reviewEvent = await insertReviewEvent({
    tenantDb: args.tenantDb,
    dealId: args.dealId,
    userId: args.userId,
    eventType: "market_override_set",
    beforeJson: before as unknown as Record<string, unknown>,
    afterJson: effectiveMarket as unknown as Record<string, unknown>,
    reason: args.reason ?? null,
  });

  return {
    override,
    reviewEvent,
    effectiveMarket,
    rerunRequestId,
  };
}

export async function clearDealMarketOverride(args: {
  tenantDb: TenantDb;
  dealId: string;
  userId: string;
  officeId: string | null;
  reason?: string | null;
}) {
  const before = await getDealEffectiveMarketContext(args.tenantDb, args.dealId);
  const [cleared] = await args.tenantDb
    .delete(estimateDealMarketOverrides)
    .where(eq(estimateDealMarketOverrides.dealId, args.dealId))
    .returning();

  if (!cleared) {
    throw new AppError(404, "Estimate market override not found");
  }

  const rerunRequestId = randomUUID();
  await enqueueGenerationRerun({
    tenantDb: args.tenantDb,
    officeId: args.officeId,
    dealId: args.dealId,
    rerunRequestId,
    reason: "market_override_cleared",
  });
  const effectiveMarket = await getDealEffectiveMarketContext(args.tenantDb, args.dealId);
  const reviewEvent = await insertReviewEvent({
    tenantDb: args.tenantDb,
    dealId: args.dealId,
    userId: args.userId,
    eventType: "market_override_cleared",
    beforeJson: before as unknown as Record<string, unknown>,
    afterJson: effectiveMarket as unknown as Record<string, unknown>,
    reason: args.reason ?? null,
  });

  return {
    cleared,
    reviewEvent,
    effectiveMarket,
    rerunRequestId,
  };
}
