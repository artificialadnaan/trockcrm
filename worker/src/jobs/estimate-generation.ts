import { drizzle } from "drizzle-orm/node-postgres";
import { and, eq, sql } from "drizzle-orm";
import * as schema from "@trock-crm/shared/schema";
import {
  costCatalogSources,
  estimateExtractions,
  estimateExtractionMatches,
  estimateGenerationRuns,
  estimatePricingRecommendations,
  estimateReviewEvents,
} from "@trock-crm/shared/schema";
import { pool } from "../db.js";
import { listCatalogCandidatesForMatching, resolveActiveCatalogSnapshotVersionId } from "../../../server/src/modules/estimating/catalog-read-model-service.js";
import { getHistoricalPricingSignals } from "../../../server/src/modules/estimating/historical-pricing-service.js";
import { rankExtractionMatches } from "../../../server/src/modules/estimating/matching-service.js";
import { buildPricingRecommendation } from "../../../server/src/modules/estimating/pricing-service.js";

async function resolveSchemaName(officeId: string | null) {
  if (!officeId) throw new Error("Unable to resolve office schema for estimate generation");

  const result = await pool.query<{ slug: string }>(
    "SELECT slug FROM public.offices WHERE id = $1 AND is_active = true LIMIT 1",
    [officeId]
  );

  const slug = result.rows[0]?.slug;
  if (!slug) throw new Error("Unable to resolve office schema for estimate generation");
  return `office_${slug}`;
}

export async function runEstimateGeneration(payload: { documentId?: string; dealId?: string }, officeId: string | null) {
  const schemaName = await resolveSchemaName(officeId);
  const appDb = drizzle(pool, { schema, casing: "snake_case" as any });
  const tenantDb = drizzle(pool, { schema, casing: "snake_case" as any });

  await tenantDb.execute(sql.raw(`SET search_path TO ${schemaName}, public`));

  const [source] = await appDb
    .select({ id: costCatalogSources.id })
    .from(costCatalogSources)
    .where(eq(costCatalogSources.provider, "procore"))
    .limit(1);

  const [run] = await tenantDb
    .insert(estimateGenerationRuns)
    .values({
      dealId: payload.dealId ?? "",
      status: "running",
      inputSnapshotJson: {
        documentId: payload.documentId ?? null,
      },
    })
    .returning();

  try {
    if (!payload.dealId) {
      throw new Error("dealId is required for estimate generation");
    }

    const historicalSignals = await getHistoricalPricingSignals(tenantDb as any, payload.dealId);
    const catalogSnapshotVersionId = source
      ? await resolveActiveCatalogSnapshotVersionId(appDb as any, source.id)
      : null;

    const pendingExtractions = await tenantDb
      .select()
      .from(estimateExtractions)
      .where(
        and(
          eq(estimateExtractions.dealId, payload.dealId),
          eq(estimateExtractions.status, "pending")
        )
      );

    const catalogItems =
      source && catalogSnapshotVersionId
        ? await listCatalogCandidatesForMatching(appDb as any, source.id, catalogSnapshotVersionId)
        : [];

    for (const extraction of pendingExtractions) {
      const matches = await rankExtractionMatches({
        extraction,
        catalogItems: catalogItems as any,
        historicalItems: historicalSignals.historicalItems as any,
      });

      const topMatch = matches[0];
      if (!topMatch) {
        await tenantDb.insert(estimateReviewEvents).values({
          dealId: extraction.dealId,
          projectId: extraction.projectId,
          subjectType: "estimate_extraction",
          subjectId: extraction.id,
          eventType: "unmatched",
          afterJson: { normalizedLabel: extraction.normalizedLabel },
        });
        await tenantDb
          .update(estimateExtractions)
          .set({ status: "unmatched" })
          .where(eq(estimateExtractions.id, extraction.id));
        continue;
      }

      const [savedMatch] = await tenantDb
        .insert(estimateExtractionMatches)
        .values({
          extractionId: extraction.id,
          catalogItemId: topMatch.catalogItemId,
          matchType: "catalog_plus_history",
          matchScore: topMatch.matchScore.toString(),
          status: "suggested",
          reasonJson: topMatch.reasons,
          evidenceJson: {
            historicalLineItemIds: topMatch.historicalLineItemIds,
          },
        })
        .returning();

      const recommendation = buildPricingRecommendation({
        quantity: Number(extraction.quantity ?? 1),
        catalogBaselinePrice: topMatch.catalogBaselinePrice ?? null,
        historicalPrices: topMatch.historicalUnitPrices ?? [],
        vendorQuotePrice: topMatch.vendorQuotePrice ?? historicalSignals.vendorQuotes[0]?.unitPrice ?? null,
        awardedOutcomeAdjustmentPercent: topMatch.awardedOutcomeAdjustmentPercent ?? 0,
        internalAdjustmentPercent: topMatch.internalAdjustmentPercent ?? 0,
        regionId: historicalSignals.currentDeal?.regionId ?? null,
        projectTypeId: historicalSignals.currentDeal?.projectTypeId ?? null,
      });

      await tenantDb.insert(estimatePricingRecommendations).values({
        dealId: extraction.dealId,
        projectId: extraction.projectId,
        extractionMatchId: savedMatch.id,
        recommendedQuantity: String(extraction.quantity ?? 1),
        recommendedUnit: extraction.unit ?? null,
        recommendedUnitPrice: String(recommendation.recommendedUnitPrice),
        recommendedTotalPrice: String(recommendation.recommendedTotalPrice),
        priceBasis: recommendation.priceBasis,
        catalogBaselinePrice:
          recommendation.catalogBaselinePrice != null
            ? String(recommendation.catalogBaselinePrice)
            : null,
        historicalMedianPrice:
          recommendation.historicalMedianPrice != null
            ? String(recommendation.historicalMedianPrice)
            : null,
        marketAdjustmentPercent: String(recommendation.marketAdjustmentPercent),
        confidence: String(recommendation.confidence),
        assumptionsJson: recommendation.assumptions,
        evidenceJson: {
          comparableHistoricalPrices: recommendation.comparableHistoricalPrices,
        },
        createdByRunId: run.id,
        status: "pending",
      });

      await tenantDb
        .update(estimateExtractions)
        .set({ status: "processed" })
        .where(eq(estimateExtractions.id, extraction.id));
    }

    await tenantDb
      .update(estimateGenerationRuns)
      .set({
        status: "completed",
        completedAt: new Date(),
        catalogSnapshotVersionId,
      })
      .where(eq(estimateGenerationRuns.id, run.id));
  } catch (error) {
    await tenantDb
      .update(estimateGenerationRuns)
      .set({
        status: "failed",
        completedAt: new Date(),
        errorSummary: error instanceof Error ? error.message : "estimate generation failed",
      })
      .where(eq(estimateGenerationRuns.id, run.id));
    throw error;
  }
}
