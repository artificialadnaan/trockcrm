import { drizzle } from "drizzle-orm/node-postgres";
import { and, desc, eq, sql } from "drizzle-orm";
import * as schema from "@trock-crm/shared/schema";
import {
  costCatalogSources,
  estimateExtractions,
  estimateGenerationRuns,
  estimateReviewEvents,
} from "@trock-crm/shared/schema";
import { pool } from "../db.js";
import { listCatalogCandidatesForMatching, resolveActiveCatalogSnapshotVersionId } from "../../../server/src/modules/estimating/catalog-read-model-service.js";
import { getHistoricalPricingSignals } from "../../../server/src/modules/estimating/historical-pricing-service.js";
import { createMarketRateProvider } from "../../../server/src/modules/estimating/market-rate-provider.js";
import { resolveMarketContext } from "../../../server/src/modules/estimating/market-resolution-service.js";
import { calculateMarketRateAdjustment } from "../../../server/src/modules/estimating/market-rate-service.js";
import { rankExtractionMatches } from "../../../server/src/modules/estimating/matching-service.js";
import {
  applyMarketRateAdjustment,
  isInferredRecommendationRowEligible,
  buildPricingRecommendation,
  resolvePricingScopeFromExtraction,
  isConfirmedMeasurementCandidateForPricing,
} from "../../../server/src/modules/estimating/pricing-service.js";
import { cloneManualRowsForGenerationRun } from "../../../server/src/modules/estimating/draft-estimate-service.js";
import { buildRecommendationOptionSet } from "../../../server/src/modules/estimating/recommendation-option-service.js";
import { persistPricingRecommendationBundle } from "../../../server/src/modules/estimating/recommendation-persistence-service.js";

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

function normalizeIntent(label: string) {
  return label.trim().toLowerCase().replace(/\s+/g, " ");
}

function buildSourceRowIdentity(input: {
  sourceType: "extracted" | "inferred";
  extractionId: string;
  normalizedIntent: string;
  sectionName: string | null;
}) {
  if (input.sourceType === "inferred") {
    const sectionSlug = (input.sectionName ?? "general").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");
    return `inferred:${input.normalizedIntent}:${sectionSlug}:${input.extractionId}`;
  }

  return `extracted:${input.extractionId}`;
}

export async function runEstimateGeneration(
  payload: { documentId?: string; dealId?: string; parseRunId?: string; rerunRequestId?: string },
  officeId: string | null
) {
  const schemaName = await resolveSchemaName(officeId);
  const appDb = drizzle(pool, { schema, casing: "snake_case" as any });
  const lockedClient = payload.documentId ? await pool.connect() : null;
  const tenantDb = drizzle(lockedClient ?? pool, { schema, casing: "snake_case" as any });
  let transactionClosed = false;
  let generationRunId: string | null = null;
  let effectiveParseRunId = payload.parseRunId ?? null;

  try {
    if (lockedClient) {
      await lockedClient.query(`SET search_path TO ${schemaName}, public`);
    } else {
      await tenantDb.execute(sql.raw(`SET search_path TO ${schemaName}, public`));
    }

    const [run] = await tenantDb
      .insert(estimateGenerationRuns)
      .values({
        dealId: payload.dealId ?? "",
        status: "running",
        inputSnapshotJson: {
          documentId: payload.documentId ?? null,
          parseRunId: effectiveParseRunId,
          rerunRequestId: payload.rerunRequestId ?? null,
        },
      })
      .returning();
    generationRunId = run.id;

    if (lockedClient) {
      await lockedClient.query("BEGIN");
      await lockedClient.query(`SET LOCAL search_path TO ${schemaName}, public`);

      const documentLock = await lockedClient.query(
        `SELECT id, active_parse_run_id
         FROM ${schemaName}.estimate_source_documents
         WHERE id = $1
           AND active_parse_run_id IS NOT NULL
           AND ($2::uuid IS NULL OR active_parse_run_id = $2)
           AND parse_status = 'completed'
           AND ocr_status = 'completed'
         LIMIT 1
         FOR UPDATE`,
        [payload.documentId, payload.parseRunId]
      );

      if (!documentLock.rows[0]) {
        await lockedClient.query("ROLLBACK");
        transactionClosed = true;
        await tenantDb
          .update(estimateGenerationRuns)
          .set({
            status: "failed",
            completedAt: new Date(),
            errorSummary: "estimate generation skipped: parse run is no longer active",
          })
          .where(eq(estimateGenerationRuns.id, generationRunId));
        return;
      }

      effectiveParseRunId =
        documentLock.rows[0]?.active_parse_run_id ?? effectiveParseRunId;

      await tenantDb
        .update(estimateGenerationRuns)
        .set({
          inputSnapshotJson: {
            documentId: payload.documentId ?? null,
            parseRunId: effectiveParseRunId,
            rerunRequestId: payload.rerunRequestId ?? null,
          },
        })
        .where(eq(estimateGenerationRuns.id, generationRunId));
    }

    if (!payload.dealId) {
      throw new Error("dealId is required for estimate generation");
    }

    const previousRunQuery = tenantDb
      .select({ id: estimateGenerationRuns.id })
      .from(estimateGenerationRuns)
      .where(
        and(
          eq(estimateGenerationRuns.dealId, payload.dealId),
          eq(estimateGenerationRuns.status, "completed")
        )
      ) as any;
    const previousRunRows =
      typeof previousRunQuery.orderBy === "function"
        ? await previousRunQuery.orderBy(desc(estimateGenerationRuns.startedAt)).limit(1)
        : await previousRunQuery;
    const [previousCompletedRun] = Array.isArray(previousRunRows) ? previousRunRows : [previousRunRows];

    if (previousCompletedRun?.id) {
      await cloneManualRowsForGenerationRun({
        tenantDb: tenantDb as any,
        dealId: payload.dealId,
        sourceGenerationRunId: previousCompletedRun.id,
        targetGenerationRunId: generationRunId,
      });
    }

    const [source] = await appDb
      .select({ id: costCatalogSources.id })
      .from(costCatalogSources)
      .where(eq(costCatalogSources.provider, "procore"))
      .limit(1);

    const candidateExtractionFilters = [
      eq(estimateExtractions.dealId, payload.dealId),
      sql`
        (
          ${estimateExtractions.status} = 'pending'
          or ${estimateExtractions.extractionType} = 'measurement_candidate'
        )
      `,
      sql`${estimateExtractions.metadataJson}->>'activeArtifact' = 'true'`,
    ];

    if (payload.documentId) {
      candidateExtractionFilters.push(eq(estimateExtractions.documentId, payload.documentId));
    }

    if (effectiveParseRunId) {
      candidateExtractionFilters.push(
        sql`${estimateExtractions.metadataJson}->>'sourceParseRunId' = ${effectiveParseRunId}`
      );
    }

    if (payload.documentId && effectiveParseRunId) {
      candidateExtractionFilters.push(sql`
        exists (
          select 1
          from estimate_source_documents as document
          where document.id = ${payload.documentId}
            and document.active_parse_run_id = ${effectiveParseRunId}
            and document.parse_status = 'completed'
            and document.ocr_status = 'completed'
        )
      `);
    }

    const historicalSignals = await getHistoricalPricingSignals(tenantDb as any, payload.dealId);
    const marketRateProvider = createMarketRateProvider(tenantDb as any);
    const marketResolution = await resolveMarketContext(marketRateProvider, {
      dealId: payload.dealId,
      dealZip: historicalSignals.currentDeal?.dealZip ?? null,
      dealState: historicalSignals.currentDeal?.dealState ?? null,
      dealRegionId: historicalSignals.currentDeal?.dealRegionId ?? null,
      propertyZip: historicalSignals.currentDeal?.propertyZip ?? null,
      propertyState: historicalSignals.currentDeal?.propertyState ?? null,
      propertyRegionId: null,
    });
    const catalogSnapshotVersionId = source
      ? await resolveActiveCatalogSnapshotVersionId(appDb as any, source.id)
      : null;

    const pendingExtractions = await tenantDb
      .select()
      .from(estimateExtractions)
      .where(and(...candidateExtractionFilters));
    const eligibleExtractions = pendingExtractions.filter((extraction) =>
      isConfirmedMeasurementCandidateForPricing(extraction)
    );

    const catalogItems =
      source && catalogSnapshotVersionId
        ? await listCatalogCandidatesForMatching(appDb as any, source.id, catalogSnapshotVersionId)
        : [];

    for (const extraction of eligibleExtractions) {
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

      const normalizedIntent = normalizeIntent(extraction.normalizedLabel ?? extraction.rawLabel ?? "");
      const sourceType =
        extraction.extractionType === "inferred_scope" ||
        (typeof extraction.metadataJson === "object" &&
          extraction.metadataJson !== null &&
          (extraction.metadataJson as Record<string, unknown>).sourceType === "inferred")
          ? "inferred"
          : "extracted";
      const sourceRowIdentity = buildSourceRowIdentity({
        sourceType,
        extractionId: extraction.id,
        normalizedIntent,
        sectionName: extraction.divisionHint ?? null,
      });
      const recommendationSet = buildRecommendationOptionSet({
        sectionName: extraction.divisionHint ?? null,
        normalizedIntent,
        sourceRowIdentity,
        candidates: [
          ...matches.map((match) => ({
            optionLabel: String(match.catalogItemId),
            catalogItemId: match.catalogItemId,
            score: match.matchScore,
            historicalSelectionCount: match.historicalLineItemIds.length,
            unitCompatibilityScore: match.reasons.unitMatched ? 10 : 0,
            absolutePriceDeviation:
              match.catalogBaselinePrice != null && match.vendorQuotePrice != null
                ? Math.abs(Number(match.vendorQuotePrice) - Number(match.catalogBaselinePrice))
                : 0,
            stableId: match.catalogItemId,
            evidenceJson: {
              historicalLineItemIds: match.historicalLineItemIds,
              reasons: match.reasons,
            },
          })),
          ...(sourceType === "inferred"
            ? []
            : [
                {
                  optionLabel: extraction.rawLabel ?? extraction.normalizedLabel ?? "Custom item",
                  normalizedCustomItemKey: normalizedIntent,
                  score: Math.max((matches[0]?.matchScore ?? 0) - 1, 0),
                  historicalSelectionCount: 0,
                  unitCompatibilityScore: 0,
                  absolutePriceDeviation: 0,
                  stableId: `custom:${normalizedIntent}`,
                  evidenceJson: {
                    source: "custom_fallback",
                    normalizedIntent,
                  },
                },
              ]),
        ],
      });

      const documentEvidence = {
        documentId: extraction.documentId ?? null,
        sourceExtractionId: extraction.id,
        sourceText: extraction.evidenceText ?? extraction.rawLabel ?? extraction.normalizedLabel ?? null,
      };
      const dependencySupportCount =
        typeof extraction.metadataJson === "object" &&
        extraction.metadataJson !== null
          ? Number((extraction.metadataJson as Record<string, unknown>).dependencySupportCount ?? 0)
          : 0;
      const historicalSupportCount = topMatch.historicalLineItemIds.length;

      if (
        sourceType === "inferred" &&
        !isInferredRecommendationRowEligible({
          sourceType,
          documentEvidence,
          historicalSupportCount,
          dependencySupportCount: Number.isFinite(dependencySupportCount) ? dependencySupportCount : 0,
        })
      ) {
        await tenantDb
          .update(estimateExtractions)
          .set({ status: "unmatched" })
          .where(eq(estimateExtractions.id, extraction.id));
        continue;
      }

      const recommendation = buildPricingRecommendation({
        quantity: Number(extraction.quantity ?? 1),
        catalogBaselinePrice: topMatch.catalogBaselinePrice ?? null,
        historicalPrices: topMatch.historicalUnitPrices ?? [],
        vendorQuotePrice: topMatch.vendorQuotePrice ?? historicalSignals.vendorQuotes[0]?.unitPrice ?? null,
        awardedOutcomeAdjustmentPercent: topMatch.awardedOutcomeAdjustmentPercent ?? 0,
        internalAdjustmentPercent: topMatch.internalAdjustmentPercent ?? 0,
        regionId: historicalSignals.currentDeal?.dealRegionId ?? null,
        projectTypeId: historicalSignals.currentDeal?.projectTypeId ?? null,
      });
      const pricingScope = resolvePricingScopeFromExtraction({
        divisionHint: extraction.divisionHint,
        metadataJson: extraction.metadataJson,
        normalizedIntent,
        rawLabel: extraction.rawLabel ?? extraction.normalizedLabel ?? null,
      });
      const marketAdjustment = await calculateMarketRateAdjustment(marketRateProvider, {
        marketResolution,
        pricingScopeType: pricingScope.pricingScopeType,
        pricingScopeKey: pricingScope.pricingScopeKey,
        baselinePrice: recommendation.recommendedTotalPrice,
        componentBreakdown: null,
        asOf: new Date(),
      });
      const enrichedRecommendation = applyMarketRateAdjustment({
        recommendation,
        marketRateAdjustment: marketAdjustment,
      });
      const recommendationRationaleJson = {
        ...recommendationSet.rationaleJson,
        evidenceJson: {
          documentEvidence,
          comparableHistoricalPrices: recommendation.comparableHistoricalPrices,
          marketRate: marketAdjustment.rationale,
        },
      };

      if (!lockedClient && typeof tenantDb.transaction === "function") {
        await tenantDb.transaction(async (tx: any) => {
          await persistPricingRecommendationBundle({
            tenantDb: tx,
            generationRunId,
            extraction: {
              id: extraction.id,
              dealId: extraction.dealId,
              projectId: extraction.projectId,
              documentId: extraction.documentId ?? null,
              quantity: Number(extraction.quantity ?? 1),
              unit: extraction.unit ?? null,
              sourceType,
              normalizedIntent,
              sourceRowIdentity,
              evidenceText: extraction.evidenceText ?? null,
              rawLabel: extraction.rawLabel ?? null,
              normalizedLabel: extraction.normalizedLabel ?? null,
            },
            topMatch: {
              catalogItemId: topMatch.catalogItemId,
              matchScore: topMatch.matchScore,
              reasons: topMatch.reasons,
              historicalLineItemIds: topMatch.historicalLineItemIds,
              catalogBaselinePrice: topMatch.catalogBaselinePrice ?? null,
            },
            recommendation: enrichedRecommendation,
            recommendationSet,
            rationaleJson: recommendationRationaleJson,
          });
        });
      } else {
        await persistPricingRecommendationBundle({
          tenantDb: tenantDb as any,
          generationRunId,
          extraction: {
            id: extraction.id,
            dealId: extraction.dealId,
            projectId: extraction.projectId,
            documentId: extraction.documentId ?? null,
            quantity: Number(extraction.quantity ?? 1),
            unit: extraction.unit ?? null,
            sourceType,
            normalizedIntent,
            sourceRowIdentity,
            evidenceText: extraction.evidenceText ?? null,
            rawLabel: extraction.rawLabel ?? null,
            normalizedLabel: extraction.normalizedLabel ?? null,
          },
          topMatch: {
            catalogItemId: topMatch.catalogItemId,
            matchScore: topMatch.matchScore,
            reasons: topMatch.reasons,
            historicalLineItemIds: topMatch.historicalLineItemIds,
            catalogBaselinePrice: topMatch.catalogBaselinePrice ?? null,
            },
            recommendation: enrichedRecommendation,
            recommendationSet,
            rationaleJson: recommendationRationaleJson,
        });
      }
    }

    await tenantDb
      .update(estimateGenerationRuns)
      .set({
        status: "completed",
        completedAt: new Date(),
        catalogSnapshotVersionId,
      })
      .where(eq(estimateGenerationRuns.id, generationRunId));

    if (lockedClient) {
      await lockedClient.query("COMMIT");
      transactionClosed = true;
    }
  } catch (error) {
    if (lockedClient && !transactionClosed) {
      await lockedClient.query("ROLLBACK").catch(() => {});
      transactionClosed = true;
      if (generationRunId) {
        await lockedClient.query(`SET search_path TO ${schemaName}, public`);
      }
    }
    if (generationRunId) {
      await tenantDb
        .update(estimateGenerationRuns)
        .set({
          status: "failed",
          completedAt: new Date(),
          errorSummary: error instanceof Error ? error.message : "estimate generation failed",
        })
        .where(eq(estimateGenerationRuns.id, generationRunId));
    }
    throw error;
  } finally {
    lockedClient?.release();
  }
}
