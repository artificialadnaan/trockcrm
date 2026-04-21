import { and, desc, eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import {
  estimateExtractions,
  estimateExtractionMatches,
  estimatePricingRecommendations,
  estimateReviewEvents,
  estimateSourceDocuments,
} from "@trock-crm/shared/schema";
import { estimatePricingRecommendationOptions } from "../../../../shared/src/schema/tenant/estimate-pricing-recommendation-options.js";
import { AppError } from "../../middleware/error-handler.js";

type TenantDb = NodePgDatabase<typeof schema>;

type EstimatePricingRecommendationRow = Record<string, any>;

export type EstimatePricingRecommendationReviewAction =
  | "accept_recommended"
  | "accept_manual_row"
  | "switch_to_alternate"
  | "override"
  | "reject"
  | "pending_review";

type DerivedPricingRow = EstimatePricingRecommendationRow & {
  reviewState: "pending_review" | "approved" | "overridden" | "rejected";
  duplicateGroupKey: string;
  duplicateGroupBlocked: boolean;
  suppressedByDuplicateGroup: boolean;
  promotable: boolean;
};

type ActiveParseArtifactRow = {
  documentId: string;
  metadataJson?: unknown;
};

function normalizeScopeLabel(value: unknown, fallback: string) {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function normalizeLookupKey(value: unknown, fallback: string) {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : fallback;
}

function getPricingRowSectionName(row: EstimatePricingRecommendationRow) {
  return normalizeScopeLabel(
    row.sectionName ?? row.divisionHint ?? row.evidenceJson?.sectionName,
    "Generated Estimate"
  );
}

function getPricingRowIntent(row: EstimatePricingRecommendationRow) {
  return normalizeScopeLabel(
    row.normalizedIntent ?? row.sourceRowIdentity ?? row.manualLabel ?? row.id,
    row.id ?? "unspecified"
  );
}

function getReviewState(status: unknown): DerivedPricingRow["reviewState"] {
  if (status === "overridden") return "overridden";
  if (status === "rejected") return "rejected";
  if (status === "pending_review" || status === "pending") return "pending_review";
  return "approved";
}

function isDuplicateBlockingCandidate(
  row: EstimatePricingRecommendationRow,
  reviewState: DerivedPricingRow["reviewState"]
) {
  if (row.sourceType === "inferred") return true;
  if (row.promotedEstimateLineItemId) return true;
  return reviewState === "approved" || reviewState === "overridden";
}

function hasManualPromotionValues(row: EstimatePricingRecommendationRow) {
  if (row.sourceType !== "manual") {
    return true;
  }

  const quantity =
    typeof (row.recommendedQuantity ?? row.manualQuantity) === "string"
      ? (row.recommendedQuantity ?? row.manualQuantity).trim()
      : (row.recommendedQuantity ?? row.manualQuantity);
  const unitPrice =
    typeof (row.recommendedUnitPrice ?? row.manualUnitPrice) === "string"
      ? (row.recommendedUnitPrice ?? row.manualUnitPrice).trim()
      : (row.recommendedUnitPrice ?? row.manualUnitPrice);
  return Boolean(quantity && unitPrice);
}

function normalizeOptionalNumericString(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

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

export function deriveEstimatePricingWorkbenchRows(
  pricingRows: EstimatePricingRecommendationRow[]
): DerivedPricingRow[] {
  const duplicateGroupCounts = new Map<string, number>();

  for (const row of pricingRows) {
    const reviewState = getReviewState(row.status);
    if (!isDuplicateBlockingCandidate(row, reviewState)) {
      continue;
    }

    const sectionName = getPricingRowSectionName(row);
    const intent = getPricingRowIntent(row);
    const key = `${normalizeLookupKey(sectionName, "generated estimate")}::${normalizeLookupKey(intent, row.id ?? "unspecified")}`;
    duplicateGroupCounts.set(key, (duplicateGroupCounts.get(key) ?? 0) + 1);
  }

  return pricingRows.map((row) => {
    const sectionName = getPricingRowSectionName(row);
    const intent = getPricingRowIntent(row);
    const duplicateGroupKey = `${sectionName}::${intent}`;
    const duplicateGroupCount =
      duplicateGroupCounts.get(
        `${normalizeLookupKey(sectionName, "generated estimate")}::${normalizeLookupKey(
          intent,
          row.id ?? "unspecified"
        )}`
      ) ?? 1;
    const reviewState = getReviewState(row.status);
    const isInferred = row.sourceType === "inferred";
    const duplicateGroupBlocked = isInferred || duplicateGroupCount > 1;
    const suppressedByDuplicateGroup = isInferred;
    const promotable =
      !duplicateGroupBlocked &&
      hasManualPromotionValues(row) &&
      (reviewState === "approved" || reviewState === "overridden") &&
      !row.promotedEstimateLineItemId;

    return {
      ...row,
      sectionName,
      normalizedIntent: intent,
      reviewState,
      duplicateGroupKey,
      duplicateGroupBlocked,
      suppressedByDuplicateGroup,
      promotable,
    };
  });
}

async function loadEstimatePricingRecommendation(
  tenantDb: TenantDb,
  dealId: string,
  recommendationId: string
) {
  const [recommendation] = await tenantDb
    .select()
    .from(estimatePricingRecommendations)
    .where(
      and(
        eq(estimatePricingRecommendations.id, recommendationId),
        eq(estimatePricingRecommendations.dealId, dealId)
      )
    )
    .limit(1);

  return recommendation ?? null;
}

export async function loadPricingRecommendationOption(
  tenantDb: TenantDb,
  dealId: string,
  recommendationId: string,
  optionId: string
) {
  const [option] = await tenantDb
    .select({
      id: estimatePricingRecommendationOptions.id,
      recommendationId: estimatePricingRecommendationOptions.recommendationId,
      optionLabel: estimatePricingRecommendationOptions.optionLabel,
      optionKind: estimatePricingRecommendationOptions.optionKind,
    })
    .from(estimatePricingRecommendationOptions)
    .innerJoin(
      estimatePricingRecommendations,
      eq(estimatePricingRecommendationOptions.recommendationId, estimatePricingRecommendations.id)
    )
    .where(
      and(
        eq(estimatePricingRecommendations.dealId, dealId),
        eq(estimatePricingRecommendationOptions.recommendationId, recommendationId),
        eq(estimatePricingRecommendationOptions.id, optionId)
      )
    )
    .limit(1);

  return option ?? null;
}

async function loadRecommendedPricingRecommendationOption(
  tenantDb: TenantDb,
  dealId: string,
  recommendationId: string
) {
  const [option] = await tenantDb
    .select({
      id: estimatePricingRecommendationOptions.id,
      recommendationId: estimatePricingRecommendationOptions.recommendationId,
      optionLabel: estimatePricingRecommendationOptions.optionLabel,
      optionKind: estimatePricingRecommendationOptions.optionKind,
    })
    .from(estimatePricingRecommendationOptions)
    .innerJoin(
      estimatePricingRecommendations,
      eq(estimatePricingRecommendationOptions.recommendationId, estimatePricingRecommendations.id)
    )
    .where(
      and(
        eq(estimatePricingRecommendations.dealId, dealId),
        eq(estimatePricingRecommendationOptions.recommendationId, recommendationId),
        eq(estimatePricingRecommendationOptions.optionKind, "recommended")
      )
    )
    .limit(1);

  return option ?? null;
}

async function insertPricingReviewEvent(
  tenantDb: TenantDb,
  input: {
    dealId: string;
    recommendationId: string;
    userId: string;
    eventType: string;
    beforeJson?: Record<string, unknown>;
    afterJson?: Record<string, unknown>;
    reason?: string | null;
  }
) {
  const [event] = await tenantDb
    .insert(estimateReviewEvents)
    .values({
      dealId: input.dealId,
      subjectType: "estimate_pricing_recommendation",
      subjectId: input.recommendationId,
      eventType: input.eventType,
      userId: input.userId,
      beforeJson: input.beforeJson ?? {},
      afterJson: input.afterJson ?? {},
      reason: input.reason ?? null,
    })
    .returning();

  return event;
}

export async function updateEstimatePricingRecommendationReviewState(args: {
  tenantDb: TenantDb;
  dealId: string;
  recommendationId: string;
  userId: string;
  input: {
    action: EstimatePricingRecommendationReviewAction;
    alternateOptionId?: string | null;
    recommendedUnitPrice?: string;
    recommendedTotalPrice?: string;
    reason?: string | null;
  };
}) {
  const existing = await loadEstimatePricingRecommendation(args.tenantDb, args.dealId, args.recommendationId);

  if (!existing) {
    throw new AppError(404, "Estimate pricing recommendation not found");
  }

  if (existing.promotedEstimateLineItemId) {
    throw new AppError(409, "Promoted recommendations cannot be reviewed");
  }

  const beforeJson = {
    status: existing.status,
    selectedSourceType: existing.selectedSourceType ?? null,
    selectedOptionId: existing.selectedOptionId ?? null,
    recommendedUnitPrice: existing.recommendedUnitPrice ?? null,
    recommendedTotalPrice: existing.recommendedTotalPrice ?? null,
    overrideQuantity: existing.overrideQuantity ?? null,
    overrideUnit: existing.overrideUnit ?? null,
    overrideUnitPrice: existing.overrideUnitPrice ?? null,
    overrideNotes: existing.overrideNotes ?? null,
  };

  let eventType = "pending_review";
  let patch: Record<string, unknown> = {
    updatedAt: new Date(),
  };

  switch (args.input.action) {
    case "accept_recommended": {
      const recommendedOption = await loadRecommendedPricingRecommendationOption(
        args.tenantDb,
        args.dealId,
        args.recommendationId
      );

      if (!recommendedOption) {
        throw new AppError(404, "Recommended pricing option not found");
      }

      eventType = "accepted_recommended";
      patch = {
        ...patch,
        status: "approved",
        selectedSourceType: "catalog_option",
        selectedOptionId: recommendedOption.id,
      };
      break;
    }
    case "accept_manual_row":
      eventType = "accepted_manual_row";
      patch = {
        ...patch,
        status: "approved",
        selectedSourceType: "manual",
        selectedOptionId: null,
      };
      break;
    case "switch_to_alternate":
      if (!args.input.alternateOptionId?.trim()) {
        throw new AppError(400, "alternateOptionId is required when switching to an alternate");
      }

      const alternateOption = await loadPricingRecommendationOption(
        args.tenantDb,
        args.dealId,
        args.recommendationId,
        args.input.alternateOptionId
      );

      if (!alternateOption) {
        throw new AppError(404, "Estimate pricing recommendation option not found");
      }

      if (alternateOption.optionKind !== "alternate") {
        throw new AppError(400, "alternateOptionId must reference an alternate option");
      }

      eventType = "switched_to_alternate";
      patch = {
        ...patch,
        status: "approved",
        selectedSourceType: "alternate",
        selectedOptionId: alternateOption.id,
      };
      break;
    case "override":
      if (!args.input.reason?.trim()) {
        throw new AppError(400, "Override reason is required");
      }
      const overrideUnitPrice = normalizeOptionalNumericString(args.input.recommendedUnitPrice);
      const overrideTotalPrice = normalizeOptionalNumericString(args.input.recommendedTotalPrice);
      if (!overrideUnitPrice || !overrideTotalPrice) {
        throw new AppError(400, "Override price and total are required");
      }

      eventType = "overridden";
      patch = {
        ...patch,
        status: "overridden",
        selectedSourceType: "override",
        selectedOptionId: null,
        recommendedUnitPrice: overrideUnitPrice,
        recommendedTotalPrice: overrideTotalPrice,
        overrideUnitPrice: overrideUnitPrice,
        overrideNotes: args.input.reason,
      };
      break;
    case "reject":
      eventType = "rejected";
      patch = {
        ...patch,
        status: "rejected",
        selectedSourceType: null,
        selectedOptionId: null,
      };
      break;
    case "pending_review":
      eventType = "pending_review";
      patch = {
        ...patch,
        status: "pending_review",
        selectedSourceType: null,
        selectedOptionId: null,
      };
      break;
    default:
      throw new AppError(400, `Unsupported review action: ${args.input.action}`);
  }

  const [updated] = await args.tenantDb
    .update(estimatePricingRecommendations)
    .set(patch)
    .where(
      and(
        eq(estimatePricingRecommendations.id, args.recommendationId),
        eq(estimatePricingRecommendations.dealId, args.dealId)
      )
    )
    .returning();

  if (!updated) {
    throw new AppError(404, "Estimate pricing recommendation not found");
  }

  const reviewEvent = await insertPricingReviewEvent(args.tenantDb, {
    dealId: args.dealId,
    recommendationId: args.recommendationId,
    userId: args.userId,
    eventType,
    beforeJson,
    afterJson: {
      status: updated.status,
      selectedSourceType: updated.selectedSourceType ?? null,
      selectedOptionId: updated.selectedOptionId ?? null,
      recommendedUnitPrice: updated.recommendedUnitPrice ?? null,
      recommendedTotalPrice: updated.recommendedTotalPrice ?? null,
      overrideQuantity: updated.overrideQuantity ?? null,
      overrideUnit: updated.overrideUnit ?? null,
      overrideUnitPrice: updated.overrideUnitPrice ?? null,
      overrideNotes: updated.overrideNotes ?? null,
    },
    reason: args.input.reason ?? null,
  });

  return { recommendation: updated, reviewEvent };
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
  const pricingRecommendationIds = activePricingRows
    .map((row) => row.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  const recommendationOptionRows =
    pricingRecommendationIds.length > 0
      ? await tenantDb
          .select()
          .from(estimatePricingRecommendationOptions)
          .where(inArray(estimatePricingRecommendationOptions.recommendationId, pricingRecommendationIds))
          .orderBy(
            estimatePricingRecommendationOptions.recommendationId,
            estimatePricingRecommendationOptions.rank
          )
      : [];
  const recommendationOptionsByRecommendationId = new Map<string, typeof recommendationOptionRows>();
  for (const optionRow of recommendationOptionRows) {
    const existingOptions =
      recommendationOptionsByRecommendationId.get(optionRow.recommendationId) ?? [];
    existingOptions.push(optionRow);
    recommendationOptionsByRecommendationId.set(optionRow.recommendationId, existingOptions);
  }
  const pricingRowsWithOptions = activePricingRows.map((row) => ({
    ...row,
    recommendationOptions: recommendationOptionsByRecommendationId.get(row.id) ?? [],
  }));
  const derivedPricingRows = deriveEstimatePricingWorkbenchRows(
    pricingRowsWithOptions as EstimatePricingRecommendationRow[]
  );
  const promotablePricingRows = derivedPricingRows.filter((row) => row.promotable);

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

  const pricingSummary = {
    total: derivedPricingRows.length,
    pending: derivedPricingRows.filter((row) => row.reviewState === "pending_review").length,
    approved: derivedPricingRows.filter((row) => row.reviewState === "approved").length,
    overridden: derivedPricingRows.filter((row) => row.reviewState === "overridden").length,
    rejected: derivedPricingRows.filter((row) => row.reviewState === "rejected").length,
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
    pricingRows: derivedPricingRows,
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
