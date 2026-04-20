import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import {
  estimateExtractions,
  estimateExtractionMatches,
  estimateReviewEvents,
} from "@trock-crm/shared/schema";
import { AppError } from "../../middleware/error-handler.js";

type TenantDb = NodePgDatabase<typeof schema>;

async function loadEstimateExtractionMatch(tenantDb: TenantDb, dealId: string, matchId: string) {
  const [match] = await tenantDb
    .select({
      id: estimateExtractionMatches.id,
      extractionId: estimateExtractionMatches.extractionId,
      catalogItemId: estimateExtractionMatches.catalogItemId,
      catalogCodeId: estimateExtractionMatches.catalogCodeId,
      historicalLineItemId: estimateExtractionMatches.historicalLineItemId,
      matchType: estimateExtractionMatches.matchType,
      matchScore: estimateExtractionMatches.matchScore,
      status: estimateExtractionMatches.status,
      reasonJson: estimateExtractionMatches.reasonJson,
      evidenceJson: estimateExtractionMatches.evidenceJson,
      dealId: estimateExtractions.dealId,
    })
    .from(estimateExtractionMatches)
    .innerJoin(estimateExtractions, eq(estimateExtractionMatches.extractionId, estimateExtractions.id))
    .where(and(eq(estimateExtractionMatches.id, matchId), eq(estimateExtractions.dealId, dealId)))
    .limit(1);

  return match ?? null;
}

async function insertMatchReviewEvent(
  tenantDb: TenantDb,
  input: {
    dealId: string;
    matchId: string;
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
      subjectType: "estimate_extraction_match",
      subjectId: input.matchId,
      eventType: input.eventType,
      userId: input.userId,
      beforeJson: input.beforeJson ?? {},
      afterJson: input.afterJson ?? {},
      reason: input.reason ?? null,
    })
    .returning();

  return event;
}

export async function selectEstimateExtractionMatch(args: {
  tenantDb: TenantDb;
  dealId: string;
  matchId: string;
  userId: string;
}) {
  const existing = await loadEstimateExtractionMatch(args.tenantDb, args.dealId, args.matchId);

  if (!existing) {
    throw new AppError(404, "Estimate extraction match not found");
  }

  await args.tenantDb
    .update(estimateExtractionMatches)
    .set({ status: "suggested" })
    .where(eq(estimateExtractionMatches.extractionId, existing.extractionId));

  const [updated] = await args.tenantDb
    .update(estimateExtractionMatches)
    .set({ status: "selected" })
    .where(and(eq(estimateExtractionMatches.id, args.matchId), eq(estimateExtractionMatches.extractionId, existing.extractionId)))
    .returning();

  if (!updated) {
    throw new AppError(404, "Estimate extraction match not found");
  }

  const reviewEvent = await insertMatchReviewEvent(args.tenantDb, {
    dealId: args.dealId,
    matchId: args.matchId,
    userId: args.userId,
    eventType: "selected",
    beforeJson: {
      status: existing.status,
      matchType: existing.matchType,
      matchScore: existing.matchScore,
      catalogItemId: existing.catalogItemId,
      catalogCodeId: existing.catalogCodeId,
      historicalLineItemId: existing.historicalLineItemId,
      reasonJson: existing.reasonJson,
      evidenceJson: existing.evidenceJson,
    },
    afterJson: {
      status: updated.status,
      matchType: updated.matchType,
      matchScore: updated.matchScore,
      catalogItemId: updated.catalogItemId,
      catalogCodeId: updated.catalogCodeId,
      historicalLineItemId: updated.historicalLineItemId,
      reasonJson: updated.reasonJson,
      evidenceJson: updated.evidenceJson,
    },
  });

  return { match: updated, reviewEvent };
}

export async function rejectEstimateExtractionMatch(args: {
  tenantDb: TenantDb;
  dealId: string;
  matchId: string;
  userId: string;
  reason?: string | null;
}) {
  const existing = await loadEstimateExtractionMatch(args.tenantDb, args.dealId, args.matchId);

  if (!existing) {
    throw new AppError(404, "Estimate extraction match not found");
  }

  const [updated] = await args.tenantDb
    .update(estimateExtractionMatches)
    .set({ status: "rejected" })
    .where(and(eq(estimateExtractionMatches.id, args.matchId), eq(estimateExtractionMatches.extractionId, existing.extractionId)))
    .returning();

  if (!updated) {
    throw new AppError(404, "Estimate extraction match not found");
  }

  const reviewEvent = await insertMatchReviewEvent(args.tenantDb, {
    dealId: args.dealId,
    matchId: args.matchId,
    userId: args.userId,
    eventType: "rejected",
    beforeJson: {
      status: existing.status,
      matchType: existing.matchType,
      matchScore: existing.matchScore,
      catalogItemId: existing.catalogItemId,
      catalogCodeId: existing.catalogCodeId,
      historicalLineItemId: existing.historicalLineItemId,
      reasonJson: existing.reasonJson,
      evidenceJson: existing.evidenceJson,
    },
    afterJson: {
      status: updated.status,
      matchType: updated.matchType,
      matchScore: updated.matchScore,
      catalogItemId: updated.catalogItemId,
      catalogCodeId: updated.catalogCodeId,
      historicalLineItemId: updated.historicalLineItemId,
      reasonJson: updated.reasonJson,
      evidenceJson: updated.evidenceJson,
    },
    reason: args.reason ?? null,
  });

  return { match: updated, reviewEvent };
}
