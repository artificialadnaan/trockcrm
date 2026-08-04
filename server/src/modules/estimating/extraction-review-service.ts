import { and, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import { estimateExtractions, estimateReviewEvents } from "@trock-crm/shared/schema";
import { AppError } from "../../middleware/error-handler.js";
import { resolvePricingScopeFromExtraction } from "./pricing-service.js";

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

async function loadEstimateExtraction(
  tenantDb: TenantDb,
  dealId: string,
  extractionId: string
) {
  const [extraction] = await tenantDb
    .select()
    .from(estimateExtractions)
    .where(
      and(
        eq(estimateExtractions.id, extractionId),
        eq(estimateExtractions.dealId, dealId)
      )
    )
    .limit(1);

  return extraction ?? null;
}

function buildUpdatedPricingScopeMetadata(input: {
  existingMetadataJson: unknown;
  normalizedLabel: string | null | undefined;
  divisionHint: string | null | undefined;
  rawLabel: string | null | undefined;
}) {
  const metadata =
    input.existingMetadataJson &&
    typeof input.existingMetadataJson === "object" &&
    input.existingMetadataJson !== null
      ? { ...(input.existingMetadataJson as Record<string, unknown>) }
      : {};

  delete metadata.pricingScopeType;
  delete metadata.pricingScopeKey;
  delete metadata.scopeType;
  delete metadata.scopeKey;

  const pricingScope = resolvePricingScopeFromExtraction({
    divisionHint: input.divisionHint ?? null,
    metadataJson: metadata,
    normalizedIntent: input.normalizedLabel ?? input.rawLabel ?? null,
    rawLabel: input.rawLabel ?? input.normalizedLabel ?? null,
  });

  return {
    ...metadata,
    ...pricingScope,
  };
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
  const existing = await loadEstimateExtraction(args.tenantDb, args.dealId, args.extractionId);

  if (!existing) {
    throw new AppError(404, "Estimate extraction not found");
  }

  const nextQuantity = args.input.quantity ?? existing.quantity;

  // SUPPLYING THE MISSING NUMBER MUST PUT THE ROW BACK IN THE QUEUE, or `needs_quantity` is a trap
  // rather than a flag.
  //
  // The generation job marks a quantity-less row `needs_quantity` and skips pricing it. The candidate
  // query then selects non-measurement rows ONLY when `status = 'pending'` — so a row corrected here
  // would keep the flag, never be re-selected, and never produce a pricing recommendation again. The
  // estimator does exactly what the flag asks and the row silently stays dead: worse than the
  // mispricing the flag replaced, because that at least produced a number somebody could challenge.
  //
  // Reset only from `needs_quantity`, and only once a quantity actually exists. Any other status is
  // somebody else's state machine — `approved`, `unmatched`, `overridden` all mean things this edit has
  // no business rewriting — and a null quantity would send the row back to be flagged again on the next
  // run, which is a loop rather than a fix.
  //
  // DECIDED IN SQL, UNDER THE UPDATE'S OWN ROW LOCK, not from the snapshot read above. `existing` is
  // read before this statement takes its lock, so the generation job can claim the row in between:
  // the read sees `pending`, the worker commits `needs_quantity`, and this update then writes the
  // quantity while leaving the flag in place. The row ends up corrected AND excluded from every later
  // candidate query — the same permanent stranding, reached through the opposite interleaving. A
  // JavaScript boolean computed from a stale row cannot see that; a CASE evaluated when the row is
  // locked can.
  //
  // Whether a quantity EXISTS is still decided here, because that is a fact about this request's own
  // input rather than about the stored row.
  const suppliesQuantity = nextQuantity !== null && nextQuantity !== undefined;
  const statusAfterEdit = sql`case when ${estimateExtractions.status} = 'needs_quantity' then 'pending' else ${estimateExtractions.status} end`;

  const [updated] = await args.tenantDb
    .update(estimateExtractions)
    .set({
      normalizedLabel: args.input.normalizedLabel ?? existing.normalizedLabel,
      quantity: nextQuantity,
      ...(suppliesQuantity ? { status: statusAfterEdit } : {}),
      unit: args.input.unit ?? existing.unit,
      divisionHint: args.input.divisionHint ?? existing.divisionHint,
      metadataJson: buildUpdatedPricingScopeMetadata({
        existingMetadataJson: existing.metadataJson,
        normalizedLabel: args.input.normalizedLabel ?? existing.normalizedLabel,
        divisionHint: args.input.divisionHint ?? existing.divisionHint,
        rawLabel: existing.rawLabel ?? existing.normalizedLabel ?? null,
      }),
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
  const existing = await loadEstimateExtraction(args.tenantDb, args.dealId, args.extractionId);

  if (!existing) {
    throw new AppError(404, "Estimate extraction not found");
  }

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
    beforeJson: {
      status: existing.status,
      normalizedLabel: existing.normalizedLabel,
      quantity: existing.quantity,
      unit: existing.unit,
      divisionHint: existing.divisionHint,
    },
    afterJson: {
      status: "approved",
      normalizedLabel: updated.normalizedLabel,
      quantity: updated.quantity,
      unit: updated.unit,
      divisionHint: updated.divisionHint,
    },
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
  const existing = await loadEstimateExtraction(args.tenantDb, args.dealId, args.extractionId);

  if (!existing) {
    throw new AppError(404, "Estimate extraction not found");
  }

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
    beforeJson: {
      status: existing.status,
      normalizedLabel: existing.normalizedLabel,
      quantity: existing.quantity,
      unit: existing.unit,
      divisionHint: existing.divisionHint,
    },
    afterJson: {
      status: "rejected",
      normalizedLabel: updated.normalizedLabel,
      quantity: updated.quantity,
      unit: updated.unit,
      divisionHint: updated.divisionHint,
    },
    reason: args.reason ?? null,
  });

  return { extraction: updated, reviewEvent };
}
