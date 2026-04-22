import { desc, eq, ne } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import { deals, estimateLineItems, estimateSections, properties } from "@trock-crm/shared/schema";
import { resolveDealMarketLocation } from "./market-resolution-service.js";

type TenantDb = NodePgDatabase<typeof schema>;

export async function getHistoricalPricingSignals(tenantDb: TenantDb, dealId: string) {
  const currentDeal = await tenantDb
    .select({
      id: deals.id,
      projectTypeId: deals.projectTypeId,
      dealRegionId: deals.regionId,
      dealZip: deals.propertyZip,
      dealState: deals.propertyState,
      propertyId: deals.propertyId,
    })
    .from(deals)
    .where(eq(deals.id, dealId))
    .limit(1);

  const currentDealRow = currentDeal[0] ?? null;
  let propertyLocation = null;

  if (currentDealRow?.propertyId && (!currentDealRow.dealZip || !currentDealRow.dealState)) {
    const [propertyRow] = await tenantDb
      .select({
        zip: properties.zip,
        state: properties.state,
      })
      .from(properties)
      .where(eq(properties.id, currentDealRow.propertyId))
      .limit(1);

    propertyLocation = propertyRow ?? null;
  }

  const resolvedLocation = resolveDealMarketLocation({
    dealZip: currentDealRow?.dealZip ?? null,
    dealState: currentDealRow?.dealState ?? null,
    dealRegionId: currentDealRow?.dealRegionId ?? null,
    propertyZip: propertyLocation?.zip ?? null,
    propertyState: propertyLocation?.state ?? null,
    propertyRegionId: null,
  });

  const resolvedDeal = currentDealRow
    ? {
        ...currentDealRow,
        propertyZip: propertyLocation?.zip ?? null,
        propertyState: propertyLocation?.state ?? null,
        resolvedZip: resolvedLocation.zip,
        resolvedState: resolvedLocation.state,
      }
    : null;

  const historicalItems = await tenantDb
    .select({
      id: estimateLineItems.id,
      description: estimateLineItems.description,
      unit: estimateLineItems.unit,
      unitPrice: estimateLineItems.unitPrice,
      costCode: estimateSections.name,
      vendorQuotePrice: estimateLineItems.unitPrice,
    })
    .from(estimateLineItems)
    .innerJoin(estimateSections, eq(estimateLineItems.sectionId, estimateSections.id))
    .where(ne(estimateSections.dealId, dealId))
    .orderBy(desc(estimateLineItems.updatedAt))
    .limit(200);

  return {
    currentDeal: resolvedDeal,
    historicalItems,
    awardedOutcomes: [],
    vendorQuotes: historicalItems
      .filter((item) => item.unitPrice != null)
      .slice(0, 25)
      .map((item) => ({ unitPrice: Number(item.unitPrice) })),
    wonBidPatterns: [],
  };
}
