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

  const documentsSummary = {
    total: documents.length,
    queued: documents.filter((row) => row.ocrStatus === "queued").length,
    failed: documents.filter((row) => row.ocrStatus === "failed").length,
  };

  const extractionsSummary = {
    total: extractionRows.length,
    pending: extractionRows.filter((row) => row.status === "pending").length,
    approved: extractionRows.filter((row) => row.status === "approved").length,
    rejected: extractionRows.filter((row) => row.status === "rejected").length,
    unmatched: extractionRows.filter((row) => row.status === "unmatched").length,
  };

  const matchesSummary = {
    total: matchRows.length,
    suggested: matchRows.filter((row) => row.status === "suggested").length,
    selected: matchRows.filter((row) => row.status === "selected").length,
    rejected: matchRows.filter((row) => row.status === "rejected").length,
  };

  const promotablePricingRows = pricingRows.filter(
    (row) => row.status === "approved" || row.status === "overridden"
  );

  const pricingSummary = {
    total: pricingRows.length,
    pending: pricingRows.filter((row) => row.status === "pending").length,
    approved: pricingRows.filter((row) => row.status === "approved").length,
    overridden: pricingRows.filter((row) => row.status === "overridden").length,
    rejected: pricingRows.filter((row) => row.status === "rejected").length,
    readyToPromote: promotablePricingRows.length,
  };

  const generationRunIds = Array.from(
    new Set(
      promotablePricingRows
        .map((row) => row.createdByRunId)
        .filter((runId): runId is string => typeof runId === "string" && runId.length > 0)
    )
  );

  const canPromote = promotablePricingRows.length > 0 && generationRunIds.length > 0;

  return {
    documents,
    extractionRows,
    matchRows,
    pricingRows,
    reviewEvents,
    summary: {
      documents: documentsSummary,
      extractions: extractionsSummary,
      matches: matchesSummary,
      pricing: pricingSummary,
    },
    promotionReadiness: {
      canPromote,
      generationRunIds,
    },
  };
}
