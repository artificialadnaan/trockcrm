import { randomUUID } from "node:crypto";
import { and, eq, isNotNull } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import {
  estimatePricingRecommendations,
} from "@trock-crm/shared/schema";
import { AppError } from "../../middleware/error-handler.js";
import { resolveManualPromotionValues } from "./manual-row-service.js";

type TenantDb = NodePgDatabase<typeof schema>;

export type PromoteManualRowToLocalCatalogInput = {
  overrideQuantity?: string | null;
  overrideUnit?: string | null;
  overrideUnitPrice?: string | null;
  overrideNotes?: string | null;
};

function buildSyntheticLocalCatalogItem(args: {
  localCatalogItemId: string;
  manualLabel: string | null;
  values: ReturnType<typeof resolveManualPromotionValues>;
}) {
  return {
    id: args.localCatalogItemId,
    sourceType: "local_promoted",
    name: args.manualLabel ?? args.values.description,
    description: args.values.notes ?? null,
    unit: args.values.unit ?? null,
    defaultQuantity: args.values.quantity,
    defaultUnitPrice: args.values.unitPrice,
  };
}

export async function promoteManualRowToLocalCatalog(args: {
  tenantDb: TenantDb;
  dealId: string;
  recommendationId: string;
  userId: string;
  input: PromoteManualRowToLocalCatalogInput;
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

  if (existing.sourceType !== "manual") {
    throw new AppError(400, "Only manual rows can be promoted to the local catalog");
  }

  if (existing.selectedSourceType === "catalog_option" || existing.selectedOptionId) {
    throw new AppError(400, "Catalog-backed manual rows are not eligible for local catalog promotion");
  }

  if (existing.promotedLocalCatalogItemId) {
    const values = resolveManualPromotionValues({
      manualLabel: existing.manualLabel,
      manualQuantity: existing.manualQuantity,
      manualUnit: existing.manualUnit,
      manualUnitPrice: existing.manualUnitPrice,
      manualNotes: existing.manualNotes,
      overrideQuantity: existing.overrideQuantity,
      overrideUnit: existing.overrideUnit,
      overrideUnitPrice: existing.overrideUnitPrice,
      overrideNotes: existing.overrideNotes,
    });

    return {
      recommendation: existing,
      localCatalogItem: buildSyntheticLocalCatalogItem({
        localCatalogItemId: existing.promotedLocalCatalogItemId,
        manualLabel: existing.manualLabel,
        values,
      }),
    };
  }

  const [reused] = await args.tenantDb
    .select({
      id: estimatePricingRecommendations.promotedLocalCatalogItemId,
    })
    .from(estimatePricingRecommendations)
    .where(
      and(
        eq(estimatePricingRecommendations.dealId, args.dealId),
        eq(estimatePricingRecommendations.manualIdentityKey, existing.manualIdentityKey),
        isNotNull(estimatePricingRecommendations.promotedLocalCatalogItemId)
      )
    )
    .limit(1);

  if (reused?.id) {
    const [updated] = await args.tenantDb
      .update(estimatePricingRecommendations)
      .set({
        promotedLocalCatalogItemId: reused.id,
        catalogBacking: "local_promoted",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(estimatePricingRecommendations.id, existing.id),
          eq(estimatePricingRecommendations.dealId, args.dealId)
        )
      )
      .returning();

    if (!updated) {
      throw new AppError(404, "Manual estimate recommendation not found");
    }

    const values = resolveManualPromotionValues({
      manualLabel: updated.manualLabel,
      manualQuantity: updated.manualQuantity,
      manualUnit: updated.manualUnit,
      manualUnitPrice: updated.manualUnitPrice,
      manualNotes: updated.manualNotes,
      overrideQuantity: updated.overrideQuantity,
      overrideUnit: updated.overrideUnit,
      overrideUnitPrice: updated.overrideUnitPrice,
      overrideNotes: updated.overrideNotes,
    });

    return {
      recommendation: updated,
      localCatalogItem: buildSyntheticLocalCatalogItem({
        localCatalogItemId: updated.promotedLocalCatalogItemId,
        manualLabel: updated.manualLabel,
        values,
      }),
    };
  }

  const values = resolveManualPromotionValues({
    manualLabel: existing.manualLabel,
    manualQuantity: existing.manualQuantity,
    manualUnit: existing.manualUnit,
    manualUnitPrice: existing.manualUnitPrice,
    manualNotes: existing.manualNotes,
    overrideQuantity: args.input.overrideQuantity ?? existing.overrideQuantity,
    overrideUnit: args.input.overrideUnit ?? existing.overrideUnit,
    overrideUnitPrice: args.input.overrideUnitPrice ?? existing.overrideUnitPrice,
    overrideNotes: args.input.overrideNotes ?? existing.overrideNotes,
  });

  const promotedLocalCatalogItemId = randomUUID();

  const [updated] = await args.tenantDb
    .update(estimatePricingRecommendations)
    .set({
      promotedLocalCatalogItemId,
      catalogBacking: "local_promoted",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(estimatePricingRecommendations.id, existing.id),
        eq(estimatePricingRecommendations.dealId, args.dealId)
      )
    )
    .returning();

  if (!updated) {
    throw new AppError(404, "Manual estimate recommendation not found");
  }

  return {
    recommendation: updated,
    localCatalogItem: buildSyntheticLocalCatalogItem({
      localCatalogItemId: updated.promotedLocalCatalogItemId,
      manualLabel: updated.manualLabel,
      values,
    }),
  };
}
