import { desc, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import {
  estimateExtractions,
  estimateExtractionMatches,
  estimatePricingRecommendations,
  estimateReviewEvents,
  estimateSourceDocuments,
} from "@trock-crm/shared/schema";

type TenantDb = NodePgDatabase<typeof schema>;

export async function buildEstimatingWorkbenchState(tenantDb: TenantDb, dealId: string) {
  const [documents, extractionRows, matchRows, pricingRows, reviewEvents] = await Promise.all([
    tenantDb
      .select()
      .from(estimateSourceDocuments)
      .where(eq(estimateSourceDocuments.dealId, dealId))
      .orderBy(desc(estimateSourceDocuments.createdAt)),
    tenantDb
      .select()
      .from(estimateExtractions)
      .where(eq(estimateExtractions.dealId, dealId))
      .orderBy(desc(estimateExtractions.createdAt)),
    tenantDb
      .select({
        id: estimateExtractionMatches.id,
        extractionId: estimateExtractionMatches.extractionId,
        catalogItemId: estimateExtractionMatches.catalogItemId,
        catalogCodeId: estimateExtractionMatches.catalogCodeId,
        historicalLineItemId: estimateExtractionMatches.historicalLineItemId,
        matchType: estimateExtractionMatches.matchType,
        matchScore: estimateExtractionMatches.matchScore,
        status: estimateExtractionMatches.status,
        reasonJson: estimateExtractionMatches.reasonJson,
        evidenceJson: estimateExtractionMatches.evidenceJson,
        createdAt: estimateExtractionMatches.createdAt,
      })
      .from(estimateExtractionMatches)
      .innerJoin(
        estimateExtractions,
        eq(estimateExtractionMatches.extractionId, estimateExtractions.id)
      )
      .where(eq(estimateExtractions.dealId, dealId))
      .orderBy(desc(estimateExtractionMatches.createdAt)),
    tenantDb
      .select()
      .from(estimatePricingRecommendations)
      .where(eq(estimatePricingRecommendations.dealId, dealId))
      .orderBy(desc(estimatePricingRecommendations.createdAt)),
    tenantDb
      .select()
      .from(estimateReviewEvents)
      .where(eq(estimateReviewEvents.dealId, dealId))
      .orderBy(desc(estimateReviewEvents.createdAt)),
  ]);

  const approvedRecommendationCount = pricingRows.filter((row) => row.status === "approved").length;

  return {
    documents,
    extractionRows,
    matchRows,
    pricingRows,
    reviewEvents,
    summary: {
      documentCount: documents.length,
      extractionCount: extractionRows.length,
      matchCount: matchRows.length,
      recommendationCount: pricingRows.length,
      approvedRecommendationCount,
      reviewEventCount: reviewEvents.length,
    },
    promotionReady: approvedRecommendationCount > 0,
  };
}
