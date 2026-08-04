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

const SERVER_ESTIMATING_MODULES = {
  catalogReadModel: [
    "../../../server/dist/modules/estimating/catalog-read-model-service.js",
    "../../../server/src/modules/estimating/catalog-read-model-service.js",
  ],
  historicalPricing: [
    "../../../server/dist/modules/estimating/historical-pricing-service.js",
    "../../../server/src/modules/estimating/historical-pricing-service.js",
  ],
  marketRateProvider: [
    "../../../server/dist/modules/estimating/market-rate-provider.js",
    "../../../server/src/modules/estimating/market-rate-provider.js",
  ],
  marketResolution: [
    "../../../server/dist/modules/estimating/market-resolution-service.js",
    "../../../server/src/modules/estimating/market-resolution-service.js",
  ],
  marketRateService: [
    "../../../server/dist/modules/estimating/market-rate-service.js",
    "../../../server/src/modules/estimating/market-rate-service.js",
  ],
  matching: [
    "../../../server/dist/modules/estimating/matching-service.js",
    "../../../server/src/modules/estimating/matching-service.js",
  ],
  pricing: [
    "../../../server/dist/modules/estimating/pricing-service.js",
    "../../../server/src/modules/estimating/pricing-service.js",
  ],
  draftEstimate: [
    "../../../server/dist/modules/estimating/draft-estimate-service.js",
    "../../../server/src/modules/estimating/draft-estimate-service.js",
  ],
  recommendationOption: [
    "../../../server/dist/modules/estimating/recommendation-option-service.js",
    "../../../server/src/modules/estimating/recommendation-option-service.js",
  ],
  recommendationPersistence: [
    "../../../server/dist/modules/estimating/recommendation-persistence-service.js",
    "../../../server/src/modules/estimating/recommendation-persistence-service.js",
  ],
} as const;

async function importFirstAvailable<T>(paths: readonly string[]): Promise<T> {
  let lastError: unknown;

  for (const path of paths) {
    try {
      return (await import(path)) as T;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Unable to import estimating module");
}

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

    const [
      catalogReadModelModule,
      historicalPricingModule,
      marketRateProviderModule,
      marketResolutionModule,
      marketRateServiceModule,
      matchingModule,
      pricingModule,
      draftEstimateModule,
      recommendationOptionModule,
      recommendationPersistenceModule,
    ] = await Promise.all([
      importFirstAvailable<any>(SERVER_ESTIMATING_MODULES.catalogReadModel),
      importFirstAvailable<any>(SERVER_ESTIMATING_MODULES.historicalPricing),
      importFirstAvailable<any>(SERVER_ESTIMATING_MODULES.marketRateProvider),
      importFirstAvailable<any>(SERVER_ESTIMATING_MODULES.marketResolution),
      importFirstAvailable<any>(SERVER_ESTIMATING_MODULES.marketRateService),
      importFirstAvailable<any>(SERVER_ESTIMATING_MODULES.matching),
      importFirstAvailable<any>(SERVER_ESTIMATING_MODULES.pricing),
      importFirstAvailable<any>(SERVER_ESTIMATING_MODULES.draftEstimate),
      importFirstAvailable<any>(SERVER_ESTIMATING_MODULES.recommendationOption),
      importFirstAvailable<any>(SERVER_ESTIMATING_MODULES.recommendationPersistence),
    ]);

    const { listCatalogCandidatesForMatching, resolveActiveCatalogSnapshotVersionId } = catalogReadModelModule;
    const { getHistoricalPricingSignals } = historicalPricingModule;
    const { createMarketRateProvider } = marketRateProviderModule;
    const { resolveMarketContext } = marketResolutionModule;
    const { calculateMarketRateAdjustment } = marketRateServiceModule;
    const { rankExtractionMatches } = matchingModule;
    const {
      applyMarketRateAdjustment,
      isInferredRecommendationRowEligible,
      buildPricingRecommendation,
      resolvePricingScopeFromExtraction,
      isConfirmedMeasurementCandidateForPricing,
    } = pricingModule;
    const { cloneManualRowsForGenerationRun } = draftEstimateModule;
    const { buildRecommendationOptionSet } = recommendationOptionModule;
    const { persistPricingRecommendationBundle } = recommendationPersistenceModule;

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
      // A ROW WITH NO QUANTITY IS NOT PRICEABLE, and until now it was priced anyway.
      //
      // `Number(extraction.quantity ?? 1)` appeared three times below — once to compute the
      // recommendation and twice to persist it — and each turned "nobody said how much" into "one of
      // them". One unit of anything has a price, so the row emerged carrying a number no evidence
      // supports, indistinguishable in the totals from a quantity somebody actually stated. The
      // walkthrough ingress refuses null quantities at the door specifically to keep its rows away
      // from this; OCR-parsed rows have always been able to reach it.
      //
      // Skipped BEFORE matching rather than defaulted after it: matching costs work whose answer
      // cannot be used. `needs_quantity` is a new status value, which `status` being plain `text` with
      // no enum and no CHECK makes a code-only change — see schema/tenant/estimate-extractions.ts.
      //
      // The row is NOT dropped and NOT failed. It is a real line item somebody has to put a number on,
      // and it stays visible as one; what it must not do is carry a price nobody chose.
      if (extraction.quantity === null || extraction.quantity === undefined) {
        // ALREADY FLAGGED ⇒ say nothing further. The candidate filter is
        // `status = 'pending' OR extraction_type = 'measurement_candidate'`, so a normal row drops out
        // of the set the moment it is marked — but a MEASUREMENT CANDIDATE is re-selected on every run
        // regardless of status. Without this, one unmeasured candidate emits a fresh `needs_quantity`
        // event on every generation run for as long as it lacks a number, burying the review feed under
        // repetitions of a fact already recorded. The row still skips pricing either way.
        if (extraction.status === "needs_quantity") continue;

        // THE CLAIM IS THE CONDITIONAL UPDATE, and it comes FIRST.
        //
        // The read above is a fast path, not a guarantee: `eligibleExtractions` was selected earlier, so
        // by now another run may have flagged this row and — the case that actually hurts — an estimator
        // may have supplied the missing quantity. An unconditional `set({status:'needs_quantity'})` would
        // stamp the flag onto a row that now HAS a number, and since the candidate query only re-selects
        // non-measurement rows at `status = 'pending'`, that row would never be priced again. The lost
        // update recreates, through a race, exactly the trap this flag is supposed to avoid.
        //
        // A single UPDATE ... WHERE takes a row lock and either matches or does not, so of two
        // overlapping runs exactly one claims the row. Ordering the claim BEFORE the event is what makes
        // the event idempotent without a transaction: the run that loses the claim writes nothing.
        //
        // CLAIMS ONLY IF NOTHING CHANGED SINCE THE READ, which is why the predicate pins the status to
        // the one the snapshot saw rather than merely to "not already flagged". `status <> needs_quantity`
        // matches `approved` and `rejected` too, so a reviewer who decided the row between the select and
        // this update would have their decision overwritten with `needs_quantity` — and an event recorded
        // claiming the row needs a number it may well now have. Pinning the observed status makes the
        // claim lose that race instead of winning it wrongly, and it subsumes the not-already-flagged
        // case: a row another run flagged no longer matches either.
        //
        // It also stays correct for measurement candidates, whose claimable status is whatever the
        // candidate filter admitted rather than always `pending`.
        // ATOMIC WITH ITS EVENT, because the claim is not retryable once it commits. If the insert
        // fails after the row is flagged, the row is `needs_quantity` with no record of why — and a
        // later run cannot repair it, since an ordinary extraction is excluded by the `status =
        // 'pending'` candidate filter. The event is gone for good rather than merely late.
        //
        // Only the deal-wide path needs this. When `payload.documentId` is present the whole run is
        // already inside the locked client's transaction (BEGIN/COMMIT around this loop), so the two
        // statements commit or roll back together there without any help. This mirrors the same
        // `!lockedClient && typeof tenantDb.transaction === "function"` test the persist path below uses.
        const flagQuantitylessRow = async (db: any): Promise<void> => {
          const claimed = await db
            .update(estimateExtractions)
            .set({ status: "needs_quantity" })
            .where(
              and(
                eq(estimateExtractions.id, extraction.id),
                sql`${estimateExtractions.quantity} is null`,
                sql`${estimateExtractions.status} = ${extraction.status}`
              )
            )
            .returning({ id: estimateExtractions.id });

          if (claimed.length === 0) return;

          await db.insert(estimateReviewEvents).values({
            dealId: extraction.dealId,
            projectId: extraction.projectId,
            subjectType: "estimate_extraction",
            subjectId: extraction.id,
            eventType: "needs_quantity",
            afterJson: { normalizedLabel: extraction.normalizedLabel },
          });
        };

        if (!lockedClient && typeof tenantDb.transaction === "function") {
          await tenantDb.transaction(async (tx: any) => {
            // SET LOCAL FIRST, because this transaction is on a DIFFERENT CONNECTION.
            //
            // On the deal-wide path `tenantDb` wraps the shared pool, and the `SET search_path` above
            // ran as one statement on whichever connection happened to serve it. Opening a transaction
            // checks out a connection of its own, which carries the default search_path — so without
            // this the claim and its event would address `public`, or another office's schema entirely
            // while several tenants have jobs in flight. Wrapping these two statements for atomicity
            // introduced that exposure; this closes it rather than trading one defect for another.
            //
            // LOCAL, so it reverts when the transaction ends and cannot leak the tenant onto a pooled
            // connection that some later, unrelated statement borrows.
            await tx.execute(sql.raw(`SET LOCAL search_path TO ${schemaName}, public`));
            await flagQuantitylessRow(tx);
          });
        } else {
          await flagQuantitylessRow(tenantDb);
        }
        continue;
      }

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
          ...matches.map((match: any) => ({
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
        quantity: Number(extraction.quantity),
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
              quantity: Number(extraction.quantity),
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
            quantity: Number(extraction.quantity),
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
