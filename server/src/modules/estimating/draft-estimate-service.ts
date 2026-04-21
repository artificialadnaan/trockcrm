import { and, eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import {
  estimateExtractions,
  estimateExtractionMatches,
  estimatePricingRecommendations,
  estimateReviewEvents,
  estimateSections,
} from "@trock-crm/shared/schema";
import { createLineItem, createSection } from "../deals/estimate-service.js";
import { AppError } from "../../middleware/error-handler.js";
import { deriveEstimatePricingWorkbenchRows } from "./workbench-service.js";

type TenantDb = NodePgDatabase<typeof schema>;

type PromotionCandidateRow = {
  recommendationId: string;
  description: string;
  quantity: string | null;
  unit: string | null;
  unitPrice: string | null;
  notes: string | null;
  sectionName: string | null;
  sourceType?: string | null;
  normalizedIntent?: string | null;
  sourceRowIdentity?: string | null;
  promotedEstimateLineItemId?: string | null;
  status?: string | null;
  createdByRunId?: string | null;
};

export async function listPreviouslyPromotedRecommendationIds(
  tenantDb: TenantDb,
  dealId: string,
  recommendationIds: string[]
) {
  if (recommendationIds.length === 0) return [];

  const rows = await tenantDb
    .select({ subjectId: estimateReviewEvents.subjectId })
    .from(estimateReviewEvents)
    .where(
      and(
        eq(estimateReviewEvents.dealId, dealId),
        eq(estimateReviewEvents.subjectType, "estimate_pricing_recommendation"),
        eq(estimateReviewEvents.eventType, "promoted"),
        inArray(estimateReviewEvents.subjectId, recommendationIds)
      )
    );

  return rows.map((row) => row.subjectId);
}

export async function loadApprovedRecommendationsForRun(
  tenantDb: TenantDb,
  dealId: string,
  generationRunId: string,
  recommendationIds: string[]
) {
  if (recommendationIds.length === 0) return [];

  return tenantDb
    .select({
      recommendationId: estimatePricingRecommendations.id,
      description: estimateExtractions.rawLabel,
      quantity: estimatePricingRecommendations.recommendedQuantity,
      unit: estimatePricingRecommendations.recommendedUnit,
      unitPrice: estimatePricingRecommendations.recommendedUnitPrice,
      notes: estimateExtractions.evidenceText,
      sectionName: estimateExtractions.divisionHint,
      sourceType: estimatePricingRecommendations.sourceType,
      normalizedIntent: estimatePricingRecommendations.normalizedIntent,
      sourceRowIdentity: estimatePricingRecommendations.sourceRowIdentity,
      promotedEstimateLineItemId: estimatePricingRecommendations.promotedEstimateLineItemId,
      status: estimatePricingRecommendations.status,
      createdByRunId: estimatePricingRecommendations.createdByRunId,
    })
    .from(estimatePricingRecommendations)
    .innerJoin(
      estimateExtractionMatches,
      eq(estimatePricingRecommendations.extractionMatchId, estimateExtractionMatches.id)
    )
    .innerJoin(
      estimateExtractions,
      eq(estimateExtractionMatches.extractionId, estimateExtractions.id)
    )
    .where(
      and(
        eq(estimatePricingRecommendations.dealId, dealId),
        eq(estimatePricingRecommendations.createdByRunId, generationRunId),
        inArray(estimatePricingRecommendations.status, ["approved", "overridden"]),
        inArray(estimatePricingRecommendations.id, recommendationIds)
      )
    ) as Promise<PromotionCandidateRow[]>;
}

function groupRecommendationsIntoSections(
  recommendations: Array<{
    recommendationId: string;
    description: string;
    quantity: string | null;
    unit: string | null;
    unitPrice: string | null;
    notes: string | null;
    sectionName: string | null;
  }>
) {
  const groups = new Map<string, typeof recommendations>();

  for (const recommendation of recommendations) {
    const key = recommendation.sectionName?.trim() || "Generated Estimate";
    const bucket = groups.get(key) ?? [];
    bucket.push(recommendation);
    groups.set(key, bucket);
  }

  return Array.from(groups.entries()).map(([sectionName, lines]) => ({
    sectionName,
    lines,
  }));
}

async function getOrCreateEstimateSection(
  tenantDb: TenantDb,
  dealId: string,
  sectionName: string
) {
  const [existingSection] = await tenantDb
    .select()
    .from(estimateSections)
    .where(
      and(
        eq(estimateSections.dealId, dealId),
        eq(estimateSections.name, sectionName)
      )
    )
    .limit(1);

  if (existingSection) return existingSection;

  return createSection(tenantDb as any, dealId, sectionName);
}

function buildRowError(row: ReturnType<typeof deriveEstimatePricingWorkbenchRows>[number]) {
  if (row.promotable) return null;
  if (row.promotedEstimateLineItemId) return null;

  if (row.duplicateGroupBlocked) {
    return {
      recommendationId: row.recommendationId,
      code: "duplicate_blocked",
      message: "Recommendation is blocked by a duplicate group and cannot be promoted.",
    };
  }

  return {
    recommendationId: row.recommendationId,
    code: "not_promotable",
    message: "Recommendation is not in a promotable state.",
  };
}

export async function promoteApprovedRecommendationsToEstimate({
  tenantDb,
  dealId,
  generationRunId,
  approvedRecommendationIds,
}: {
  tenantDb: TenantDb;
  dealId: string;
  generationRunId: string;
  approvedRecommendationIds: string[];
}) {
  const alreadyPromoted = await listPreviouslyPromotedRecommendationIds(
    tenantDb,
    dealId,
    approvedRecommendationIds
  );

  const recommendations = await loadApprovedRecommendationsForRun(
    tenantDb,
    dealId,
    generationRunId,
    approvedRecommendationIds.filter((id) => !alreadyPromoted.includes(id))
  );

  const derivedRecommendations = deriveEstimatePricingWorkbenchRows(
    recommendations as unknown as PromotionCandidateRow[]
  );
  const rowErrors = derivedRecommendations
    .map(buildRowError)
    .filter((rowError): rowError is NonNullable<typeof rowError> => rowError !== null);
  const promotableRecommendations = derivedRecommendations.filter((row) => row.promotable);
  const promotedRecommendationIds: string[] = [];

  if (promotableRecommendations.length === 0) {
    return { promotedRecommendationIds, rowErrors };
  }

  for (const sectionGroup of groupRecommendationsIntoSections(promotableRecommendations)) {
    const section = await getOrCreateEstimateSection(
      tenantDb,
      dealId,
      sectionGroup.sectionName
    );

    for (const line of sectionGroup.lines) {
      const lineItem = await createLineItem(tenantDb as any, dealId, section.id, {
        description: line.description,
        quantity: line.quantity ?? "1",
        unit: line.unit ?? undefined,
        unitPrice: line.unitPrice ?? "0",
        notes: line.notes ?? undefined,
      });

      await tenantDb
        .update(estimatePricingRecommendations)
        .set({
          promotedEstimateLineItemId: lineItem.id,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(estimatePricingRecommendations.id, line.recommendationId),
            eq(estimatePricingRecommendations.dealId, dealId)
          )
        )
        .returning();

      await tenantDb.insert(estimateReviewEvents).values({
        dealId,
        subjectType: "estimate_pricing_recommendation",
        subjectId: line.recommendationId,
        eventType: "promoted",
        afterJson: { estimateLineItemId: lineItem.id },
      });

      promotedRecommendationIds.push(line.recommendationId);
    }
  }

  return { promotedRecommendationIds, rowErrors };
}

export async function approveEstimateRecommendation(args: {
  tenantDb: TenantDb;
  dealId: string;
  recommendationId: string;
  userId: string;
  reason?: string | null;
}) {
  const [recommendation] = await args.tenantDb
    .update(estimatePricingRecommendations)
    .set({
      status: "approved",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(estimatePricingRecommendations.id, args.recommendationId),
        eq(estimatePricingRecommendations.dealId, args.dealId)
      )
    )
    .returning();

  if (!recommendation) {
    throw new AppError(404, "Estimate recommendation not found");
  }

  await args.tenantDb.insert(estimateReviewEvents).values({
    dealId: args.dealId,
    subjectType: "estimate_pricing_recommendation",
    subjectId: args.recommendationId,
    eventType: "approved",
    userId: args.userId,
    reason: args.reason ?? null,
  });

  return recommendation;
}

export async function listApprovedRecommendationIdsForRun(
  tenantDb: TenantDb,
  dealId: string,
  generationRunId: string
) {
  const rows = await tenantDb
    .select({ id: estimatePricingRecommendations.id })
    .from(estimatePricingRecommendations)
    .where(
      and(
        eq(estimatePricingRecommendations.dealId, dealId),
        eq(estimatePricingRecommendations.createdByRunId, generationRunId),
        eq(estimatePricingRecommendations.status, "approved")
      )
    );

  return rows.map((row) => row.id);
}
