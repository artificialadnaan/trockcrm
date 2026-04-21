import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import {
  estimatePricingRecommendationOptions,
  estimatePricingRecommendations,
} from "@trock-crm/shared/schema";
import { AppError } from "../../middleware/error-handler.js";

type TenantDb = NodePgDatabase<typeof schema>;

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
    const [row] = await tenantDb
      .insert(estimatePricingRecommendationOptions)
      .values({
        recommendationId,
        rank: index + 1,
        optionLabel: option.optionLabel,
        optionKind: option.optionKind ?? (index === 0 ? "recommended" : "alternate"),
        catalogItemId: option.catalogItemId ?? null,
        localCatalogItemId: option.localCatalogItemId ?? null,
      })
      .returning();

    if (row) {
      inserted.push({
        ...row,
        stableId: option.stableId ?? null,
      });
    }
  }

  return inserted;
}

export async function createManualEstimateRow(args: {
  tenantDb: TenantDb;
  dealId: string;
  userId: string;
  input: CreateManualEstimateRowInput;
}) {
  const manualIdentityKey = normalizeManualIdentityKey(args.input.manualIdentityKey);
  const selectedOption =
    args.input.catalogOptions?.find((option) => option.stableId === args.input.selectedOptionStableId) ?? null;
  const selectedSourceType =
    selectedOption || args.input.selectedSourceType === "catalog_option" ? "catalog_option" : "manual";
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

  const [recommendation] = await args.tenantDb
    .insert(estimatePricingRecommendations)
    .values(recommendationValues)
    .returning();

  if (!recommendation) {
    throw new AppError(500, "Failed to create manual recommendation");
  }

  const optionRows = await insertManualOptions(args.tenantDb, recommendation.id, args.input.catalogOptions ?? []);

  let updatedRecommendation = recommendation;
  if (selectedOption) {
    const [selectedRow] = optionRows.filter((option) => option.stableId === selectedOption.stableId);
    const [patched] = await args.tenantDb
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
      )
      .returning();

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
  const selectedOption =
    args.input.catalogOptions?.find((option) => option.stableId === args.input.selectedOptionStableId) ?? null;
  const selectedSourceType =
    args.input.selectedSourceType === "catalog_option" || selectedOption ? "catalog_option" : "manual";
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
    selectedSourceType: selectedSourceType === "catalog_option" ? "catalog_option" : "manual",
    selectedOptionId: args.input.selectedOptionId ?? existing.selectedOptionId ?? null,
    catalogBacking,
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

  if (selectedSourceType === "manual" && args.input.selectedOptionId == null) {
    patch.selectedOptionId = null;
    patch.catalogBacking = "estimate_only";
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
    throw new AppError(404, "Manual estimate recommendation not found");
  }

  const optionRows = await insertManualOptions(args.tenantDb, updated.id, args.input.catalogOptions ?? []);

  let finalRecommendation = updated;
  if (selectedOption && args.input.selectedOptionId == null) {
    const [selectedRow] = optionRows.filter((option) => option.stableId === selectedOption.stableId);
    const [patched] = await args.tenantDb
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
      )
      .returning();

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
