import { and, eq, inArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import {
  estimateExtractions,
  estimateExtractionMatches,
  estimatePricingRecommendations,
  estimatePricingRecommendationOptions,
  estimateReviewEvents,
  estimateSections,
} from "@trock-crm/shared/schema";
import { createLineItem, createSection } from "../deals/estimate-service.js";
import { AppError } from "../../middleware/error-handler.js";
import {
  deriveEstimatePricingWorkbenchRows,
  loadPricingRecommendationOption,
} from "./workbench-service.js";

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
  recommendationIds?: string[],
  options: {
    /**
     * `FOR UPDATE`, OFF BY DEFAULT AND SCOPED WHEN ON. Locking is only correct for the rows a caller is
     * about to write. Unconditionally locking the whole run held every qualifying recommendation, match
     * and extraction for the duration of section and line-item creation, so two people promoting
     * DISJOINT rows serialised, and an unrelated extraction edit blocked until the promotion finished.
     */
    lock?: boolean;
    /**
     * The effective-quantity gate, OFF BY DEFAULT. Applying it to the read that feeds duplicate-group
     * derivation is a correctness bug, not just a scoping one: a filtered-out duplicate makes its valid
     * sibling look UNIQUE, so the sibling promotes even when the filtered row already holds a promoted
     * line item. Duplicates must be derived over the whole approved/overridden set; the gate belongs
     * only on the read that decides what actually promotes.
     */
    requirePriceableQuantity?: boolean;
  } = {}
) {
  if (recommendationIds && recommendationIds.length === 0) return [];

  const conditions = [
    eq(estimatePricingRecommendations.dealId, dealId),
    eq(estimatePricingRecommendations.createdByRunId, generationRunId),
    inArray(estimatePricingRecommendations.status, ["approved", "overridden"]),
    ...(options.requirePriceableQuantity
      ? [
          // THE EFFECTIVE QUANTITY — the number promotion will actually use — must be priceable.
          //
          // `resolvePromotionLineValues` decides that number: for `selectedSourceType = 'override'` it
          // takes `overrideQuantity ?? <fallback>`, and for everything else the extraction's. So the
          // three alternatives below are mutually exclusive BY CONSTRUCTION, not by luck:
          //
          //   * a MANUAL row promotes its own quantity — so it is judged on THAT, not on the extraction
          //     its match anchors it to. "It promotes its own manualQuantity" was previously written as
          //     a blanket `source_type = 'manual'` exemption, and that is only true when the row HAS
          //     one: `manual_quantity` is nullable, `updateManualEstimateRow` writes a cleared value
          //     straight through into BOTH `manual_quantity` and `recommended_quantity`, and nothing
          //     resets the review status when it does. Nonpositive was the live half of the hole — 0 and
          //     -5 are truthy strings, so the completeness check upstream passed them and they promoted
          //     AS THEMSELVES: a $0.00 line and a -$1,250.00 line on a client-facing estimate, with no
          //     row error raised. Held to the same standard as the override branch below, for the same
          //     reason.
          //   * an override WITH a quantity of its own is judged on that quantity ALONE. The extraction
          //     fallback is explicitly excluded for it — otherwise an override carrying 0, a negative
          //     or NaN would fail its own alternative, be admitted by a healthy extraction, and then be
          //     promoted with the INVALID override value, because the resolver prefers a non-null
          //     override. That is a bad number in a client estimate, and the workbench simultaneously
          //     called the same row unpromotable.
          //   * everything else — including a PRICE-ONLY override, whose overrideQuantity is null and
          //     which therefore genuinely falls back — is judged on the extraction.
          //
          // NaN is refused explicitly throughout: Postgres orders numeric NaN ABOVE all finite values,
          // so `NaN > 0` is TRUE and a positive test alone would admit it.
          sql`(
      (
        ${estimatePricingRecommendations.sourceType} = 'manual'
        -- COALESCED, because the two columns are the two halves of one number.
        -- resolvePromotionLineValues reads manualQuantity then recommendedQuantity for a manual row
        -- (and the reverse order on the catalog-option branch), so whichever is present is what
        -- reaches the estimate; a manual row with NEITHER has no quantity anywhere and used to be
        -- fabricated as one unit.
        and coalesce(${estimatePricingRecommendations.manualQuantity}, ${estimatePricingRecommendations.recommendedQuantity}) is not null
        and coalesce(${estimatePricingRecommendations.manualQuantity}, ${estimatePricingRecommendations.recommendedQuantity}) > 0
        and coalesce(${estimatePricingRecommendations.manualQuantity}, ${estimatePricingRecommendations.recommendedQuantity}) <> 'NaN'::numeric
      )
      or (
        ${estimatePricingRecommendations.selectedSourceType} = 'override'
        and ${estimatePricingRecommendations.overrideQuantity} is not null
        and ${estimatePricingRecommendations.overrideQuantity} > 0
        and ${estimatePricingRecommendations.overrideQuantity} <> 'NaN'::numeric
      )
      or (
        (
          ${estimatePricingRecommendations.selectedSourceType} is distinct from 'override'
          or ${estimatePricingRecommendations.overrideQuantity} is null
        )
        and ${estimateExtractions.quantity} is not null
        and ${estimateExtractions.quantity} > 0
        and ${estimateExtractions.quantity} <> 'NaN'::numeric
        -- AND IT MUST BE THE NUMBER THIS RECOMMENDATION WAS PRICED FROM. Live-and-positive is not
        -- enough: a row parked at needs_quantity by migration 0215 and then CORRECTED to a real value
        -- satisfies every test above, while resolvePromotionLineValues still promotes the stored
        -- recommendedQuantity -- commonly the fabricated 1 this PR exists to remove. Correcting the
        -- extraction neither enqueues a rerun nor invalidates the recommendation, so without this the
        -- repair hands an estimator a row that looks fixed and prices the old number. Refused here so
        -- it must re-price, which is the only thing that actually repairs it. Same rule the worker's
        -- reread already enforces (stillPriceable: it must be the SAME number the recommendation was
        -- built from), applied at the other end of the same pipeline.
        and ${estimateExtractions.quantity} = ${estimatePricingRecommendations.recommendedQuantity}
      )
    )`,
        ]
      : []),
  ];

  if (recommendationIds) {
    conditions.push(inArray(estimatePricingRecommendations.id, recommendationIds));
  }

  const query = tenantDb
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
    .where(and(...conditions));

  // LOCKED ONLY WHEN ASKED, because the gate above is otherwise a check-then-act. A quantity-clearing
  // PATCH that commits after this SELECT returns but before the promotion loop writes its line item
  // would find the recommendation already admitted — and the promotion's own advisory locks cover
  // recommendation ids, not the joined extraction, so the two never serialise. `updateEstimateExtraction`
  // takes `FOR UPDATE` on that row; taking it here too is what makes them queue instead of interleave.
  //
  // Conditional because the wide duplicate-derivation read must NOT lock: it spans the whole run, and
  // holding it for the length of section and line-item creation serialised unrelated promotions.
  return (
    options.lock ? query.for("update") : query
  ) as unknown as Promise<PromotionCandidateRow[]>;
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

/** The only quantity this service will put on a line: present, finite and greater than zero.
 *
 *  The gate above already refuses everything else, so this is a backstop rather than the primary
 *  defence — but the two do not agree by construction. `resolvePromotionLineValues` coalesces
 *  `manualQuantity ?? recommendedQuantity` on the manual branch and `recommendedQuantity ??
 *  manualQuantity` on the catalog-option one, while the gate coalesces in a single fixed order, so a
 *  row whose two columns disagree can satisfy the gate on one column and promote the other. On a money
 *  path that is worth one comparison at the point of use. */
function isPromotableQuantity(value: string | null): value is string {
  if (value === null) return false;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0;
}

function resolvePromotionLineValues(
  row: ReturnType<typeof deriveEstimatePricingWorkbenchRows>[number],
  selectedOptionLabel?: string | null
) {
  let description = selectedOptionLabel ?? row.description;
  // NO `?? "1"`. That fallback is the defect this PR is named for, sitting on the other end of the same
  // pipeline as the worker's: "nobody said how much" became "one of them", and one unit of anything has
  // a price. It fabricated a number on a client-facing line rather than refusing to write one, and
  // `createLineItem` carries an identical `String(input.quantity ?? "1")` behind it — so removing this
  // one alone would only move the fabrication a function further down. The caller refuses the row
  // instead; see `isPromotableQuantity`.
  let quantity: string | null = row.quantity ?? null;
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

    // WIDE, UNGATED, UNLOCKED — the set duplicate groups are derived over. It must include rows whose
    // quantity is no longer priceable: filtering them here made a valid sibling look UNIQUE, so it
    // promoted even when the filtered row already held a promoted line item. Needing to READ a row is
    // also not a reason to LOCK it.
    const recommendations = await loadApprovedRecommendationsForRun(
      tx,
      dealId,
      generationRunId
    );

    // NARROW, GATED, LOCKED — exactly the rows this promotion will write.
    const promotableCandidates = await loadApprovedRecommendationsForRun(
      tx,
      dealId,
      generationRunId,
      approvedRecommendationIds,
      { lock: true, requirePriceableQuantity: true }
    );
    const promotableCandidateIds = new Set(
      promotableCandidates.map((row) => row.recommendationId)
    );

    const requestedRecommendationIds = new Set(approvedRecommendationIds);
    // THE LOCKED ROW'S VALUES WIN, not just its id.
    //
    // `lockPromotionCandidates` takes an ADVISORY lock, so it binds other promotions and nothing else.
    // A reviewer calling `updateEstimatePricingRecommendationReviewState` takes no such lock, and at
    // READ COMMITTED each statement gets a fresh snapshot — so an override committed between the wide
    // read above and the narrow `FOR UPDATE` read is invisible to the first and visible to the second.
    // The narrow read was contributing only its id to a Set, and the line was then built from the wide
    // row: the estimator's committed decision was discarded and the quote went out at the old number,
    // with a review event recording it as promoted. A `FOR UPDATE` whose values you throw away buys
    // nothing.
    //
    // Substituted rather than filtered, so the wide set keeps its shape: duplicate grouping must still
    // see every row of the run — including ones this promotion will not write — or a blocked sibling
    // looks unique. Rows outside the locked set keep their wide values; they are only ever counted, not
    // promoted.
    const lockedCandidatesById = new Map(
      promotableCandidates.map((row) => [row.recommendationId, row])
    );
    const derivedRecommendations = deriveEstimatePricingWorkbenchRows(
      recommendations.map(
        (row) => lockedCandidatesById.get(row.recommendationId) ?? row
      ) as unknown as PromotionCandidateRow[]
    );
    const requestedRecommendations = derivedRecommendations.filter(
      (row) =>
        requestedRecommendationIds.has(row.recommendationId) &&
        // Survived the gated, locked revalidation. A requested row that did not falls through to
        // `missingRowErrors` — the same answer the caller would have got had its quantity been cleared
        // a moment earlier — while STAYING in `derivedRecommendations`, so its duplicate sibling is
        // still correctly blocked.
        promotableCandidateIds.has(row.recommendationId)
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

        // NO NUMBER, NO LINE. Refused here rather than defaulted, because the only alternative on this
        // path is to invent one: `createLineItem` turns a null quantity into `"1"` of its own accord,
        // so falling through would put a fabricated unit on a client-facing estimate exactly as before.
        // An error the estimator can see beats a number nobody chose.
        if (!isPromotableQuantity(lineValues.quantity)) {
          rowErrors.push({
            recommendationId: line.recommendationId,
            code: "unpriceable_quantity",
            message:
              "Recommendation has no usable quantity to promote. Supply a positive quantity before promoting it.",
          });
          continue;
        }

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
