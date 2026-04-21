import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import {
  costCatalogSources,
  estimatePricingRecommendationOptions,
  estimatePricingRecommendations,
} from "@trock-crm/shared/schema";
import { AppError } from "../../middleware/error-handler.js";
import { listCatalogCandidatesForMatching, resolveActiveCatalogSnapshotVersionId } from "./catalog-read-model-service.js";

type TenantDb = NodePgDatabase<typeof schema>;
type AppDb = NodePgDatabase<typeof schema>;

export type ManualRecommendationOptionInput = {
  optionLabel: string;
  optionKind?: "recommended" | "alternate" | "manual_custom";
  catalogItemId?: string | null;
  localCatalogItemId?: string | null;
  stableId?: string | null;
};

export type CreateManualEstimateRowInput = {
  generationRunId: string;
  estimateSectionName: string;
  manualLabel: string;
  manualQuantity?: string | null;
  manualUnit?: string | null;
  manualUnitPrice?: string | null;
  manualNotes?: string | null;
  catalogQuery?: string | null;
  catalogOptions?: ManualRecommendationOptionInput[];
  selectedOptionStableId?: string | null;
  manualIdentityKey?: string | null;
  selectedSourceType?: "manual" | "catalog_option" | null;
};

export type UpdateManualEstimateRowInput = {
  estimateSectionName?: string | null;
  catalogQuery?: string | null;
  manualLabel?: string | null;
  manualQuantity?: string | null;
  manualUnit?: string | null;
  manualUnitPrice?: string | null;
  manualNotes?: string | null;
  selectedSourceType?: "manual" | "catalog_option" | null;
  selectedOptionId?: string | null;
  catalogBacking?: "estimate_only" | "procore_synced" | "local_promoted" | null;
  catalogOptions?: ManualRecommendationOptionInput[];
  selectedOptionStableId?: string | null;
  manualIdentityKey?: string | null;
};

export function normalizeManualIdentityKey(value?: string | null) {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : randomUUID();
}

export function normalizeManualIntent(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\u2019'".,;:!?\-_/\\()[\]{}]+/g, " ")
    .replace(/\s+/g, " ");
}

export function canonicalizeSectionName(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

function createManualRecommendationBase(input: {
  dealId: string;
  generationRunId: string;
  estimateSectionName: string;
  manualLabel: string;
  manualQuantity?: string | null;
  manualUnit?: string | null;
  manualUnitPrice?: string | null;
  manualNotes?: string | null;
  manualIdentityKey: string;
  manualOrigin: "manual_estimator_added" | "generated";
  selectedSourceType: "manual" | "catalog_option" | null;
  selectedOptionId?: string | null;
  catalogBacking: "estimate_only" | "procore_synced" | "local_promoted";
  promotedLocalCatalogItemId?: string | null;
}) {
  return {
    dealId: input.dealId,
    createdByRunId: input.generationRunId,
    sourceType: "manual",
    sourceRowIdentity: `manual:${input.manualIdentityKey}`,
    normalizedIntent: normalizeManualIntent(input.manualLabel),
    manualOrigin: input.manualOrigin,
    manualIdentityKey: input.manualIdentityKey,
    manualLabel: input.manualLabel,
    manualQuantity: input.manualQuantity ?? null,
    manualUnit: input.manualUnit ?? null,
    manualUnitPrice: input.manualUnitPrice ?? null,
    manualNotes: input.manualNotes ?? null,
    selectedSourceType: input.selectedSourceType,
    selectedOptionId: input.selectedOptionId ?? null,
    catalogBacking: input.catalogBacking,
    promotedLocalCatalogItemId: input.promotedLocalCatalogItemId ?? null,
    status: "pending_review",
    evidenceJson: {
      sectionName: canonicalizeSectionName(input.estimateSectionName),
      manualLabel: input.manualLabel,
      manualQuantity: input.manualQuantity ?? null,
      manualUnit: input.manualUnit ?? null,
      manualUnitPrice: input.manualUnitPrice ?? null,
      manualNotes: input.manualNotes ?? null,
    },
  };
}

async function insertManualOptions(
  tenantDb: TenantDb,
  recommendationId: string,
  options: ManualRecommendationOptionInput[]
) {
  if (options.length === 0) return [];

  const inserted: Array<ManualRecommendationOptionInput & { id: string }> = [];
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index]!;
    const insertQuery = tenantDb
      .insert(estimatePricingRecommendationOptions)
      .values({
        recommendationId,
        rank: index + 1,
        optionLabel: option.optionLabel,
        optionKind: option.optionKind ?? (index === 0 ? "recommended" : "alternate"),
        catalogItemId: option.catalogItemId ?? null,
        localCatalogItemId: option.localCatalogItemId ?? null,
      }) as any;
    const rowResult =
      typeof insertQuery.returning === "function" ? await insertQuery.returning() : await insertQuery;
    const row = Array.isArray(rowResult) ? rowResult[0] : rowResult;

    if (row) {
      inserted.push({
        ...row,
        stableId: option.stableId ?? null,
      });
    }
  }

  return inserted;
}

async function insertRecommendationRow(tenantDb: TenantDb, values: any) {
  const insertQuery = tenantDb.insert(estimatePricingRecommendations).values(values) as any;
  if (typeof insertQuery.returning === "function") {
    const rows = await insertQuery.returning();
    return rows[0] ? { ...values, ...rows[0] } : { ...values };
  }

  const result = await insertQuery;
  const row = Array.isArray(result) ? result[0] : result;
  return row ? { ...values, ...row } : { ...values };
}

async function searchManualCatalogOptions(appDb: AppDb, catalogQuery: string): Promise<ManualRecommendationOptionInput[]> {
  const sourceQuery = appDb
    .select({ id: costCatalogSources.id })
    .from(costCatalogSources)
    .where(eq(costCatalogSources.provider, "procore")) as any;
  const sourceRows = typeof sourceQuery.limit === "function" ? await sourceQuery.limit(1) : await sourceQuery;
  const [source] = Array.isArray(sourceRows) ? sourceRows : [sourceRows];

  if (!source) return [];

  const snapshotVersionId = await resolveActiveCatalogSnapshotVersionId(appDb as any, source.id);
  if (!snapshotVersionId) return [];

  const candidates = await listCatalogCandidatesForMatching(appDb as any, source.id, snapshotVersionId);
  const normalizedQuery = catalogQuery.trim().toLowerCase();

  return candidates
    .filter((candidate) => {
      const haystack = `${candidate.name ?? ""} ${candidate.primaryCode ?? ""}`.toLowerCase();
      return haystack.includes(normalizedQuery);
    })
    .map((candidate, index) => ({
      optionLabel: candidate.name,
      optionKind: index === 0 ? ("recommended" as const) : ("alternate" as const),
      catalogItemId: candidate.id,
      localCatalogItemId: null,
      stableId: candidate.id,
    }));
}

async function resolveCatalogFirstOptions(args: {
  appDb?: AppDb | null;
  catalogQuery?: string | null;
  catalogOptions?: ManualRecommendationOptionInput[];
  selectedOptionStableId?: string | null;
}) {
  if (args.catalogOptions && args.catalogOptions.length > 0) {
    const selectedOption = args.catalogOptions.find((option) => option.stableId === args.selectedOptionStableId) ?? null;
    return {
      optionRows: args.catalogOptions,
      selectedOption,
    };
  }

  if (args.catalogQuery && args.appDb) {
    const optionRows = await searchManualCatalogOptions(args.appDb, args.catalogQuery);
    const selectedOption = optionRows.find((option) => option.stableId === args.selectedOptionStableId) ?? null;
    return {
      optionRows,
      selectedOption,
    };
  }

  return {
    optionRows: [] as ManualRecommendationOptionInput[],
    selectedOption: null,
  };
}

export async function createManualEstimateRow(args: {
  tenantDb: TenantDb;
  appDb?: AppDb | null;
  dealId: string;
  userId: string;
  input: CreateManualEstimateRowInput;
}) {
  const manualIdentityKey = normalizeManualIdentityKey(args.input.manualIdentityKey);
  const requestedCatalogSelection = args.input.selectedSourceType === "catalog_option";
  const { optionRows: resolvedCatalogOptions, selectedOption } = await resolveCatalogFirstOptions({
    appDb: args.appDb ?? null,
    catalogQuery: args.input.catalogQuery ?? null,
    catalogOptions: args.input.catalogOptions ?? [],
    selectedOptionStableId: args.input.selectedOptionStableId ?? null,
  });
  const selectedSourceType = selectedOption
    ? "catalog_option"
    : requestedCatalogSelection
      ? "manual"
      : "manual";
  const catalogBacking = selectedOption?.localCatalogItemId
    ? "local_promoted"
    : selectedOption?.catalogItemId
      ? "procore_synced"
      : "estimate_only";

  const recommendationValues = createManualRecommendationBase({
    dealId: args.dealId,
    generationRunId: args.input.generationRunId,
    estimateSectionName: args.input.estimateSectionName,
    manualLabel: args.input.manualLabel,
    manualQuantity: args.input.manualQuantity ?? null,
    manualUnit: args.input.manualUnit ?? null,
    manualUnitPrice: args.input.manualUnitPrice ?? null,
    manualNotes: args.input.manualNotes ?? null,
    manualIdentityKey,
    manualOrigin: "manual_estimator_added",
    selectedSourceType: selectedSourceType === "catalog_option" ? "catalog_option" : null,
    selectedOptionId: null,
    catalogBacking: selectedSourceType === "catalog_option" ? catalogBacking : "estimate_only",
    promotedLocalCatalogItemId: null,
  });

  const recommendation = await insertRecommendationRow(args.tenantDb, recommendationValues);

  if (!recommendation) {
    throw new AppError(500, "Failed to create manual recommendation");
  }

  const optionRows = await insertManualOptions(args.tenantDb, recommendation.id, resolvedCatalogOptions);

  let updatedRecommendation = recommendation;
  if (selectedOption) {
    const [selectedRow] = optionRows.filter((option) => option.stableId === selectedOption.stableId);
    const patchedQuery = args.tenantDb
      .update(estimatePricingRecommendations)
      .set({
        selectedSourceType: "catalog_option",
        selectedOptionId: selectedRow?.id ?? null,
        catalogBacking,
      })
      .where(
        and(
          eq(estimatePricingRecommendations.id, recommendation.id),
          eq(estimatePricingRecommendations.dealId, args.dealId)
        )
      ) as any;
    const patchedRows =
      typeof patchedQuery.returning === "function" ? await patchedQuery.returning() : await patchedQuery;
    const [patched] = Array.isArray(patchedRows) ? patchedRows : [patchedRows];

    if (patched) {
      updatedRecommendation = patched;
    }
  }

  return {
    recommendation: updatedRecommendation,
    optionRows,
  };
}

export async function updateManualEstimateRow(args: {
  tenantDb: TenantDb;
  appDb?: AppDb | null;
  dealId: string;
  recommendationId: string;
  userId: string;
  input: UpdateManualEstimateRowInput;
}) {
  const [existing] = await args.tenantDb
    .select()
    .from(estimatePricingRecommendations)
    .where(
      and(
        eq(estimatePricingRecommendations.id, args.recommendationId),
        eq(estimatePricingRecommendations.dealId, args.dealId)
      )
    )
    .limit(1);

  if (!existing) {
    throw new AppError(404, "Manual estimate recommendation not found");
  }

  const manualIdentityKey = normalizeManualIdentityKey(existing.manualIdentityKey);
  const requestedCatalogSelection = args.input.selectedSourceType === "catalog_option";
  const { optionRows: resolvedCatalogOptions, selectedOption } = await resolveCatalogFirstOptions({
    appDb: args.appDb ?? null,
    catalogQuery: args.input.catalogQuery ?? null,
    catalogOptions: args.input.catalogOptions ?? [],
    selectedOptionStableId: args.input.selectedOptionStableId ?? null,
  });
  const selectedSourceType = selectedOption
    ? "catalog_option"
    : requestedCatalogSelection
      ? "manual"
      : "manual";
  const persistedSelectedSourceType = selectedSourceType === "catalog_option" ? "catalog_option" : "manual";
  const catalogBacking =
    args.input.catalogBacking ??
    (selectedOption?.localCatalogItemId
      ? "local_promoted"
      : selectedOption?.catalogItemId
        ? "procore_synced"
        : "estimate_only");

  const patch: Record<string, unknown> = {
    updatedAt: new Date(),
    manualIdentityKey,
    manualLabel: args.input.manualLabel ?? existing.manualLabel,
    manualQuantity: args.input.manualQuantity ?? existing.manualQuantity,
    manualUnit: args.input.manualUnit ?? existing.manualUnit,
    manualUnitPrice: args.input.manualUnitPrice ?? existing.manualUnitPrice,
    manualNotes: args.input.manualNotes ?? existing.manualNotes,
    selectedSourceType: persistedSelectedSourceType,
    selectedOptionId:
      persistedSelectedSourceType === "catalog_option"
        ? args.input.selectedOptionId ?? existing.selectedOptionId ?? null
        : null,
    catalogBacking: persistedSelectedSourceType === "catalog_option" ? catalogBacking : "estimate_only",
    evidenceJson: {
      ...(existing.evidenceJson as Record<string, unknown>),
      sectionName:
        args.input.estimateSectionName != null
          ? canonicalizeSectionName(args.input.estimateSectionName)
          : (existing.evidenceJson as Record<string, unknown>)?.sectionName ?? null,
      manualLabel: args.input.manualLabel ?? existing.manualLabel,
      manualQuantity: args.input.manualQuantity ?? existing.manualQuantity ?? null,
      manualUnit: args.input.manualUnit ?? existing.manualUnit ?? null,
      manualUnitPrice: args.input.manualUnitPrice ?? existing.manualUnitPrice ?? null,
      manualNotes: args.input.manualNotes ?? existing.manualNotes ?? null,
    },
  };

  const updateQuery = args.tenantDb
    .update(estimatePricingRecommendations)
    .set(patch)
    .where(
      and(
        eq(estimatePricingRecommendations.id, args.recommendationId),
        eq(estimatePricingRecommendations.dealId, args.dealId)
      )
    ) as any;
  const updatedRows =
    typeof updateQuery.returning === "function" ? await updateQuery.returning() : await updateQuery;
  const [updated] = Array.isArray(updatedRows) ? updatedRows : [updatedRows];

  if (!updated) {
    throw new AppError(404, "Manual estimate recommendation not found");
  }

  const optionRows = await insertManualOptions(args.tenantDb, updated.id, resolvedCatalogOptions);

  let finalRecommendation = updated;
  if (selectedOption && args.input.selectedOptionId == null) {
    const [selectedRow] = optionRows.filter((option) => option.stableId === selectedOption.stableId);
    const patchedQuery = args.tenantDb
      .update(estimatePricingRecommendations)
      .set({
        selectedSourceType: "catalog_option",
        selectedOptionId: selectedRow?.id ?? null,
        catalogBacking,
      })
      .where(
        and(
          eq(estimatePricingRecommendations.id, args.recommendationId),
          eq(estimatePricingRecommendations.dealId, args.dealId)
        )
      ) as any;
    const patchedRows =
      typeof patchedQuery.returning === "function" ? await patchedQuery.returning() : await patchedQuery;
    const [patched] = Array.isArray(patchedRows) ? patchedRows : [patchedRows];

    if (patched) {
      finalRecommendation = patched;
    }
  }

  return {
    recommendation: finalRecommendation,
    optionRows,
  };
}

export function resolveManualPromotionValues(row: {
  manualLabel: string | null;
  manualQuantity?: string | null;
  manualUnit?: string | null;
  manualUnitPrice?: string | null;
  manualNotes?: string | null;
  overrideQuantity?: string | null;
  overrideUnit?: string | null;
  overrideUnitPrice?: string | null;
  overrideNotes?: string | null;
}) {
  return {
    description: row.manualLabel ?? "",
    quantity: row.overrideQuantity ?? row.manualQuantity ?? "1",
    unit: row.overrideUnit ?? row.manualUnit ?? undefined,
    unitPrice: row.overrideUnitPrice ?? row.manualUnitPrice ?? "0",
    notes: row.overrideNotes ?? row.manualNotes ?? undefined,
  };
}
