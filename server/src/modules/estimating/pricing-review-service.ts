import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import {
  estimatePricingRecommendations,
  estimateReviewEvents,
} from "@trock-crm/shared/schema";
import { AppError } from "../../middleware/error-handler.js";

type TenantDb = NodePgDatabase<typeof schema>;

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

function normalizeOverridePrice(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

export async function approveEstimatePricingRecommendation(args: {
  tenantDb: TenantDb;
  dealId: string;
  recommendationId: string;
  userId: string;
}) {
  const existing = await loadEstimatePricingRecommendation(args.tenantDb, args.dealId, args.recommendationId);

  if (!existing) {
    throw new AppError(404, "Estimate pricing recommendation not found");
  }

  const [updated] = await args.tenantDb
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

  if (!updated) {
    throw new AppError(404, "Estimate pricing recommendation not found");
  }

  const reviewEvent = await insertPricingReviewEvent(args.tenantDb, {
    dealId: args.dealId,
    recommendationId: args.recommendationId,
    userId: args.userId,
    eventType: "approved",
    beforeJson: {
      status: existing.status,
      recommendedUnitPrice: existing.recommendedUnitPrice,
      recommendedTotalPrice: existing.recommendedTotalPrice,
    },
    afterJson: {
      status: updated.status,
      recommendedUnitPrice: updated.recommendedUnitPrice,
      recommendedTotalPrice: updated.recommendedTotalPrice,
    },
  });

  return { recommendation: updated, reviewEvent };
}

export async function rejectEstimatePricingRecommendation(args: {
  tenantDb: TenantDb;
  dealId: string;
  recommendationId: string;
  userId: string;
  reason?: string | null;
}) {
  const existing = await loadEstimatePricingRecommendation(args.tenantDb, args.dealId, args.recommendationId);

  if (!existing) {
    throw new AppError(404, "Estimate pricing recommendation not found");
  }

  const [updated] = await args.tenantDb
    .update(estimatePricingRecommendations)
    .set({
      status: "rejected",
      updatedAt: new Date(),
    })
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
    eventType: "rejected",
    beforeJson: {
      status: existing.status,
      recommendedUnitPrice: existing.recommendedUnitPrice,
      recommendedTotalPrice: existing.recommendedTotalPrice,
    },
    afterJson: {
      status: updated.status,
      recommendedUnitPrice: updated.recommendedUnitPrice,
      recommendedTotalPrice: updated.recommendedTotalPrice,
    },
    reason: args.reason ?? null,
  });

  return { recommendation: updated, reviewEvent };
}

export async function overrideEstimatePricingRecommendation(args: {
  tenantDb: TenantDb;
  dealId: string;
  recommendationId: string;
  userId: string;
  input: {
    recommendedUnitPrice: string;
    recommendedTotalPrice: string;
    reason: string;
  };
}) {
  if (!args.input.reason?.trim()) {
    throw new AppError(400, "Override reason is required");
  }
  const normalizedUnitPrice = normalizeOverridePrice(args.input.recommendedUnitPrice);
  const normalizedTotalPrice = normalizeOverridePrice(args.input.recommendedTotalPrice);
  if (!normalizedUnitPrice || !normalizedTotalPrice) {
    throw new AppError(400, "Override price and total are required");
  }

  const existing = await loadEstimatePricingRecommendation(args.tenantDb, args.dealId, args.recommendationId);

  if (!existing) {
    throw new AppError(404, "Estimate pricing recommendation not found");
  }

  const [updated] = await args.tenantDb
    .update(estimatePricingRecommendations)
    .set({
      status: "overridden",
      recommendedUnitPrice: normalizedUnitPrice,
      recommendedTotalPrice: normalizedTotalPrice,
      updatedAt: new Date(),
    })
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
    eventType: "overridden",
    beforeJson: {
      status: existing.status,
      recommendedUnitPrice: existing.recommendedUnitPrice,
      recommendedTotalPrice: existing.recommendedTotalPrice,
    },
    afterJson: {
      status: updated.status,
      recommendedUnitPrice: updated.recommendedUnitPrice,
      recommendedTotalPrice: updated.recommendedTotalPrice,
    },
    reason: args.input.reason,
  });

  return { recommendation: updated, reviewEvent };
}
