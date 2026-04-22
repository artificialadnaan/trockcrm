import { and, eq, inArray, sql } from "drizzle-orm";
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
import {
  deriveEstimatePricingWorkbenchRows,
  loadPricingRecommendationOption,
} from "./workbench-service.js";
import { estimatePricingRecommendationOptions } from "../../../../shared/src/schema/tenant/estimate-pricing-recommendation-options.js";

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
  selectedSourceType?: string | null;
  selectedOptionId?: string | null;
  manualLabel?: string | null;
  manualQuantity?: string | null;
  manualUnit?: string | null;
  manualUnitPrice?: string | null;
  manualNotes?: string | null;
  overrideQuantity?: string | null;
  overrideUnit?: string | null;
  overrideUnitPrice?: string | null;
  overrideNotes?: string | null;
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
  recommendationIds?: string[]
) {
  if (recommendationIds && recommendationIds.length === 0) return [];

  const conditions = [
    eq(estimatePricingRecommendations.dealId, dealId),
    eq(estimatePricingRecommendations.createdByRunId, generationRunId),
    inArray(estimatePricingRecommendations.status, ["approved", "overridden"]),
  ];

  if (recommendationIds) {
    conditions.push(inArray(estimatePricingRecommendations.id, recommendationIds));
  }

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
      selectedSourceType: estimatePricingRecommendations.selectedSourceType,
      selectedOptionId: estimatePricingRecommendations.selectedOptionId,
      manualLabel: estimatePricingRecommendations.manualLabel,
      manualQuantity: estimatePricingRecommendations.manualQuantity,
      manualUnit: estimatePricingRecommendations.manualUnit,
      manualUnitPrice: estimatePricingRecommendations.manualUnitPrice,
      manualNotes: estimatePricingRecommendations.manualNotes,
      overrideQuantity: estimatePricingRecommendations.overrideQuantity,
      overrideUnit: estimatePricingRecommendations.overrideUnit,
      overrideUnitPrice: estimatePricingRecommendations.overrideUnitPrice,
      overrideNotes: estimatePricingRecommendations.overrideNotes,
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
    .where(and(...conditions)) as Promise<PromotionCandidateRow[]>;
}

async function lockPromotionCandidates(
  tenantDb: TenantDb,
  dealId: string,
  recommendationIds: string[]
) {
  const uniqueIds = Array.from(new Set(recommendationIds)).sort();

  for (const recommendationId of uniqueIds) {
    await tenantDb.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`estimate-promotion:${dealId}:${recommendationId}`}))`
    );
  }
}

type PromotionWorkbenchRow = ReturnType<typeof deriveEstimatePricingWorkbenchRows>[number];

function groupRecommendationsIntoSections(recommendations: Array<PromotionWorkbenchRow>) {
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

function buildMissingRecommendationError(recommendationId: string) {
  return {
    recommendationId,
    code: "recommendation_unavailable",
    message: "Recommendation is no longer available for promotion.",
  };
}

function resolvePromotionLineValues(
  row: ReturnType<typeof deriveEstimatePricingWorkbenchRows>[number],
  selectedOptionLabel?: string | null
) {
  let description = selectedOptionLabel ?? row.description;
  let quantity = row.quantity ?? "1";
  let unit = row.unit ?? undefined;
  let unitPrice = row.unitPrice ?? "0";
  let notes = row.notes ?? undefined;

  switch (row.selectedSourceType) {
    case "manual":
      description = row.manualLabel ?? description;
      quantity = row.manualQuantity ?? quantity;
      unit = row.manualUnit ?? unit;
      unitPrice = row.manualUnitPrice ?? unitPrice;
      notes = row.manualNotes ?? notes;
      break;
    case "override":
      quantity = row.overrideQuantity ?? quantity;
      unit = row.overrideUnit ?? unit;
      unitPrice = row.overrideUnitPrice ?? unitPrice;
      notes = row.overrideNotes ?? notes;
      break;
    case "catalog_option":
    case "alternate":
    case "recommended":
      description = selectedOptionLabel ?? description;
      if (row.sourceType === "manual") {
        quantity = row.quantity ?? row.manualQuantity ?? quantity;
        unit = row.unit ?? row.manualUnit ?? unit;
        unitPrice = row.unitPrice ?? row.manualUnitPrice ?? unitPrice;
        notes = row.notes ?? row.manualNotes ?? notes;
      }
      break;
    default:
      if (row.sourceType === "manual") {
        description = row.manualLabel ?? description;
        quantity = row.manualQuantity ?? quantity;
        unit = row.manualUnit ?? unit;
        unitPrice = row.manualUnitPrice ?? unitPrice;
        notes = row.manualNotes ?? notes;
      }
      break;
  }

  return {
    description,
    quantity,
    unit,
    unitPrice,
    notes,
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
  const runInTransaction = async <T>(callback: (tx: TenantDb) => Promise<T>) => {
    const transaction = (tenantDb as any).transaction;
    if (typeof transaction === "function") {
      return transaction.call(tenantDb, callback);
    }

    return callback(tenantDb);
  };

  return runInTransaction(async (tx) => {
    if (approvedRecommendationIds.length === 0) {
      return { promotedRecommendationIds: [], rowErrors: [] };
    }

    await lockPromotionCandidates(tx, dealId, approvedRecommendationIds);

    const recommendations = await loadApprovedRecommendationsForRun(
      tx,
      dealId,
      generationRunId
    );

    const requestedRecommendationIds = new Set(approvedRecommendationIds);
    const derivedRecommendations = deriveEstimatePricingWorkbenchRows(
      recommendations as unknown as PromotionCandidateRow[]
    );
    const requestedRecommendations = derivedRecommendations.filter((row) =>
      requestedRecommendationIds.has(row.recommendationId)
    );
    const loadedRecommendationIds = new Set(
      requestedRecommendations.map((row) => row.recommendationId)
    );
    const missingRowErrors = approvedRecommendationIds
      .filter((recommendationId) => !loadedRecommendationIds.has(recommendationId))
      .map(buildMissingRecommendationError);
    const rowErrors = [
      ...missingRowErrors,
      ...requestedRecommendations
      .map(buildRowError)
      .filter((rowError): rowError is NonNullable<typeof rowError> => rowError !== null),
    ];
    const promotableRecommendations = requestedRecommendations.filter((row) => row.promotable);
    const promotedRecommendationIds: string[] = [];

    if (promotableRecommendations.length === 0) {
      return { promotedRecommendationIds, rowErrors };
    }

    for (const sectionGroup of groupRecommendationsIntoSections(promotableRecommendations)) {
      const section = await getOrCreateEstimateSection(
        tx,
        dealId,
        sectionGroup.sectionName
      );

      for (const line of sectionGroup.lines) {
        const selectedOption =
          ["alternate", "catalog_option", "recommended"].includes(line.selectedSourceType ?? "") &&
          line.selectedOptionId
            ? await loadPricingRecommendationOption(
                tx,
                dealId,
                line.recommendationId,
                line.selectedOptionId
              )
            : null;
        const lineValues = resolvePromotionLineValues(
          line,
          selectedOption?.optionLabel ?? null
        );

        const lineItem = await createLineItem(tx as any, dealId, section.id, {
          description: lineValues.description,
          quantity: lineValues.quantity,
          unit: lineValues.unit,
          unitPrice: lineValues.unitPrice,
          notes: lineValues.notes,
        });

        await tx
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

        await tx.insert(estimateReviewEvents).values({
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
  });
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
        inArray(estimatePricingRecommendations.status, ["approved", "overridden"])
      )
    );

  return rows.map((row) => row.id);
}

export async function cloneManualRowsForGenerationRun(args: {
  tenantDb: TenantDb;
  dealId: string;
  sourceGenerationRunId: string;
  targetGenerationRunId: string;
  userId?: string;
}) {
  const sourceRows = await args.tenantDb
    .select()
    .from(estimatePricingRecommendations)
    .where(
      and(
        eq(estimatePricingRecommendations.dealId, args.dealId),
        eq(estimatePricingRecommendations.createdByRunId, args.sourceGenerationRunId),
        eq(estimatePricingRecommendations.sourceType, "manual")
      )
    );

  const eligibleRows = sourceRows.filter(
    (row) => row.status !== "rejected" && !row.promotedEstimateLineItemId
  );
  const clonedRows: Array<Record<string, unknown>> = [];

  for (const sourceRow of eligibleRows) {
    const insertedResult = await args.tenantDb
      .insert(estimatePricingRecommendations)
      .values({
        dealId: args.dealId,
        createdByRunId: args.targetGenerationRunId,
        sourceType: "manual",
        sourceRowIdentity: sourceRow.sourceRowIdentity,
        normalizedIntent: sourceRow.normalizedIntent,
        manualOrigin: "generated",
        manualIdentityKey: sourceRow.manualIdentityKey,
        manualLabel: sourceRow.manualLabel,
        manualQuantity: sourceRow.manualQuantity,
        manualUnit: sourceRow.manualUnit,
        manualUnitPrice: sourceRow.manualUnitPrice,
        manualNotes: sourceRow.manualNotes,
        selectedSourceType: sourceRow.selectedSourceType,
        selectedOptionId: null,
        catalogBacking: sourceRow.catalogBacking,
        promotedLocalCatalogItemId: sourceRow.promotedLocalCatalogItemId,
        overrideQuantity: sourceRow.overrideQuantity,
        overrideUnit: sourceRow.overrideUnit,
        overrideUnitPrice: sourceRow.overrideUnitPrice,
        overrideNotes: sourceRow.overrideNotes,
        status: sourceRow.status,
        evidenceJson: sourceRow.evidenceJson ?? {},
        assumptionsJson: sourceRow.assumptionsJson ?? {},
        priceBasis: sourceRow.priceBasis,
        recommendedQuantity: sourceRow.recommendedQuantity,
        recommendedUnit: sourceRow.recommendedUnit,
        recommendedUnitPrice: sourceRow.recommendedUnitPrice,
        recommendedTotalPrice: sourceRow.recommendedTotalPrice,
        catalogBaselinePrice: sourceRow.catalogBaselinePrice,
        historicalMedianPrice: sourceRow.historicalMedianPrice,
        marketAdjustmentPercent: sourceRow.marketAdjustmentPercent,
        confidence: sourceRow.confidence,
        sourceDocumentId: sourceRow.sourceDocumentId,
        sourceExtractionId: sourceRow.sourceExtractionId,
        extractionMatchId: sourceRow.extractionMatchId,
        projectId: sourceRow.projectId,
      })
      ;
    const inserted = Array.isArray(insertedResult) ? insertedResult[0] : insertedResult;

    if (!inserted) {
      continue;
    }

    let clonedSelectedOptionId: string | null = null;
    const optionRows = await args.tenantDb
      .select()
      .from(estimatePricingRecommendationOptions)
      .where(eq(estimatePricingRecommendationOptions.recommendationId, sourceRow.id));

    for (const optionRow of optionRows) {
      const clonedOptionResult = await args.tenantDb
        .insert(estimatePricingRecommendationOptions)
        .values({
          recommendationId: inserted.id,
          rank: optionRow.rank,
          optionLabel: optionRow.optionLabel,
          optionKind: optionRow.optionKind,
          catalogItemId: optionRow.catalogItemId,
          localCatalogItemId: optionRow.localCatalogItemId,
        }) as any;
      const clonedOption = Array.isArray(clonedOptionResult)
        ? clonedOptionResult[0]
        : clonedOptionResult;

      if (optionRow.id === sourceRow.selectedOptionId) {
        clonedSelectedOptionId = clonedOption?.id ?? null;
      }
    }

    let persistedClone = inserted;
    if (clonedSelectedOptionId) {
      const updatedCloneResult = await args.tenantDb
        .update(estimatePricingRecommendations)
        .set({
          selectedOptionId: clonedSelectedOptionId,
          updatedAt: new Date(),
        })
        .where(eq(estimatePricingRecommendations.id, inserted.id))
        .returning();
      const updatedClone = Array.isArray(updatedCloneResult)
        ? updatedCloneResult[0]
        : updatedCloneResult;
      if (updatedClone) {
        persistedClone = updatedClone;
      }
    }

    clonedRows.push({
      ...persistedClone,
      dealId: args.dealId,
      createdByRunId: args.targetGenerationRunId,
      sourceType: "manual",
      sourceRowIdentity: sourceRow.sourceRowIdentity,
      normalizedIntent: sourceRow.normalizedIntent,
      manualOrigin: "generated",
      manualIdentityKey: sourceRow.manualIdentityKey,
      manualLabel: sourceRow.manualLabel,
      manualQuantity: sourceRow.manualQuantity,
      manualUnit: sourceRow.manualUnit,
      manualUnitPrice: sourceRow.manualUnitPrice,
      manualNotes: sourceRow.manualNotes,
      selectedSourceType: sourceRow.selectedSourceType,
      selectedOptionId: clonedSelectedOptionId,
      catalogBacking: sourceRow.catalogBacking,
      promotedLocalCatalogItemId: sourceRow.promotedLocalCatalogItemId,
      overrideQuantity: sourceRow.overrideQuantity,
      overrideUnit: sourceRow.overrideUnit,
      overrideUnitPrice: sourceRow.overrideUnitPrice,
      overrideNotes: sourceRow.overrideNotes,
      status: sourceRow.status,
    });
  }

  return {
    clonedRecommendationIds: clonedRows.map((row) => row.id as string),
    clonedRows,
  };
}
