import { desc, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import { deals, estimateLineItems, estimateSections } from "@trock-crm/shared/schema";

type TenantDb = NodePgDatabase<typeof schema>;

export async function getHistoricalPricingSignals(tenantDb: TenantDb, dealId: string) {
  const currentDeal = await tenantDb
    .select({
      id: deals.id,
      projectTypeId: deals.projectTypeId,
      regionId: deals.regionId,
    })
    .from(deals)
    .where(eq(deals.id, dealId))
    .limit(1);

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
    .orderBy(desc(estimateLineItems.updatedAt))
    .limit(200);

  return {
    currentDeal: currentDeal[0] ?? null,
    historicalItems,
    awardedOutcomes: [],
    vendorQuotes: historicalItems
      .filter((item) => item.unitPrice != null)
      .slice(0, 25)
      .map((item) => ({ unitPrice: Number(item.unitPrice) })),
    wonBidPatterns: [],
  };
}
