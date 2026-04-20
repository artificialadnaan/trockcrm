import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import { estimateExtractions, estimateReviewEvents } from "@trock-crm/shared/schema";
import { AppError } from "../../middleware/error-handler.js";

type TenantDb = NodePgDatabase<typeof schema>;

async function insertReviewEvent(
  tenantDb: TenantDb,
  input: {
    dealId: string;
    subjectId: string;
    eventType: string;
    userId: string;
    beforeJson?: Record<string, unknown>;
    afterJson?: Record<string, unknown>;
    reason?: string | null;
  }
) {
  const [event] = await tenantDb
    .insert(estimateReviewEvents)
    .values({
      dealId: input.dealId,
      subjectType: "estimate_extraction",
      subjectId: input.subjectId,
      eventType: input.eventType,
      userId: input.userId,
      beforeJson: input.beforeJson ?? {},
      afterJson: input.afterJson ?? {},
      reason: input.reason ?? null,
    })
    .returning();

  return event;
}

export async function updateEstimateExtraction(args: {
  tenantDb: TenantDb;
  dealId: string;
  extractionId: string;
  userId: string;
  input: {
    normalizedLabel?: string;
    quantity?: string | null;
    unit?: string | null;
    divisionHint?: string | null;
  };
}) {
  const [existing] = await args.tenantDb
    .select()
    .from(estimateExtractions)
    .where(
      and(
        eq(estimateExtractions.id, args.extractionId),
        eq(estimateExtractions.dealId, args.dealId)
      )
    )
    .limit(1);

  if (!existing) {
    throw new AppError(404, "Estimate extraction not found");
  }

  const [updated] = await args.tenantDb
    .update(estimateExtractions)
    .set({
      normalizedLabel: args.input.normalizedLabel ?? existing.normalizedLabel,
      quantity: args.input.quantity ?? existing.quantity,
      unit: args.input.unit ?? existing.unit,
      divisionHint: args.input.divisionHint ?? existing.divisionHint,
      updatedAt: new Date(),
    })
    .where(eq(estimateExtractions.id, args.extractionId))
    .returning();

  const reviewEvent = await insertReviewEvent(args.tenantDb, {
    dealId: args.dealId,
    subjectId: args.extractionId,
    eventType: "edited",
    userId: args.userId,
    beforeJson: {
      normalizedLabel: existing.normalizedLabel,
      quantity: existing.quantity,
      unit: existing.unit,
      divisionHint: existing.divisionHint,
    },
    afterJson: {
      normalizedLabel: updated.normalizedLabel,
      quantity: updated.quantity,
      unit: updated.unit,
      divisionHint: updated.divisionHint,
    },
  });

  return { extraction: updated, reviewEvent };
}

export async function approveEstimateExtraction(args: {
  tenantDb: TenantDb;
  dealId: string;
  extractionId: string;
  userId: string;
}) {
  const [updated] = await args.tenantDb
    .update(estimateExtractions)
    .set({
      status: "approved",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(estimateExtractions.id, args.extractionId),
        eq(estimateExtractions.dealId, args.dealId)
      )
    )
    .returning();

  if (!updated) {
    throw new AppError(404, "Estimate extraction not found");
  }

  const reviewEvent = await insertReviewEvent(args.tenantDb, {
    dealId: args.dealId,
    subjectId: args.extractionId,
    eventType: "approved",
    userId: args.userId,
    afterJson: { status: "approved" },
  });

  return { extraction: updated, reviewEvent };
}

export async function rejectEstimateExtraction(args: {
  tenantDb: TenantDb;
  dealId: string;
  extractionId: string;
  userId: string;
  reason?: string | null;
}) {
  const [updated] = await args.tenantDb
    .update(estimateExtractions)
    .set({
      status: "rejected",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(estimateExtractions.id, args.extractionId),
        eq(estimateExtractions.dealId, args.dealId)
      )
    )
    .returning();

  if (!updated) {
    throw new AppError(404, "Estimate extraction not found");
  }

  const reviewEvent = await insertReviewEvent(args.tenantDb, {
    dealId: args.dealId,
    subjectId: args.extractionId,
    eventType: "rejected",
    userId: args.userId,
    afterJson: { status: "rejected" },
    reason: args.reason ?? null,
  });

  return { extraction: updated, reviewEvent };
}
