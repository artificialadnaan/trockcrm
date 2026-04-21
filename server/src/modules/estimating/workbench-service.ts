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

type ActiveParseArtifactRow = {
  documentId: string;
  metadataJson?: unknown;
};

function isActiveParseArtifact(
  row: ActiveParseArtifactRow,
  activeParseRunIdByDocumentId: Map<string, string | null>
) {
  const activeParseRunId = activeParseRunIdByDocumentId.get(row.documentId) ?? null;
  if (!activeParseRunId) return false;

  const metadataJson = row.metadataJson;
  if (
    !metadataJson ||
    typeof metadataJson !== "object" ||
    metadataJson === null ||
    !("sourceParseRunId" in metadataJson) ||
    (metadataJson as Record<string, unknown>).sourceParseRunId !== activeParseRunId
  ) {
    return false;
  }

  return (metadataJson as Record<string, unknown>).activeArtifact !== false;
}

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

  const activeParseRunIdByDocumentId = new Map(
    documents.map((document) => [document.id, document.activeParseRunId ?? null])
  );

  const activeExtractionRows = extractionRows.filter((row) =>
    isActiveParseArtifact(row, activeParseRunIdByDocumentId)
  );
  const activeExtractionIds = new Set(activeExtractionRows.map((row) => row.id));
  const activeMatchRows = matchRows.filter((row) => activeExtractionIds.has(row.extractionId));
  const activeMatchIds = new Set(activeMatchRows.map((row) => row.id));
  const activePricingRows = pricingRows.filter((row) => activeMatchIds.has(row.extractionMatchId));

  const documentsSummary = {
    total: documents.length,
    queued: documents.filter((row) => row.ocrStatus === "queued").length,
    failed: documents.filter((row) => row.ocrStatus === "failed").length,
  };

  const extractionsSummary = {
    total: activeExtractionRows.length,
    pending: activeExtractionRows.filter((row) => row.status === "pending").length,
    approved: activeExtractionRows.filter((row) => row.status === "approved").length,
    rejected: activeExtractionRows.filter((row) => row.status === "rejected").length,
    unmatched: activeExtractionRows.filter((row) => row.status === "unmatched").length,
  };

  const matchesSummary = {
    total: activeMatchRows.length,
    suggested: activeMatchRows.filter((row) => row.status === "suggested").length,
    selected: activeMatchRows.filter((row) => row.status === "selected").length,
    rejected: activeMatchRows.filter((row) => row.status === "rejected").length,
  };

  const promotablePricingRows = activePricingRows.filter(
    (row) => row.status === "approved" || row.status === "overridden"
  );

  const pricingSummary = {
    total: activePricingRows.length,
    pending: activePricingRows.filter((row) => row.status === "pending").length,
    approved: activePricingRows.filter((row) => row.status === "approved").length,
    overridden: activePricingRows.filter((row) => row.status === "overridden").length,
    rejected: activePricingRows.filter((row) => row.status === "rejected").length,
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
    extractionRows: activeExtractionRows,
    matchRows: activeMatchRows,
    pricingRows: activePricingRows,
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
