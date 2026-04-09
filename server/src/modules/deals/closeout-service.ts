import { eq, and, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { closeoutChecklistItems } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import { AppError } from "../../middleware/error-handler.js";

type TenantDb = NodePgDatabase<typeof schema>;

export const DEFAULT_STEPS = [
  { stepKey: "final_walk", label: "Final Walk", order: 1 },
  { stepKey: "internal_punch_clear", label: "Internal Punch List Complete", order: 2 },
  { stepKey: "external_punch_clear", label: "External Punch List Complete", order: 3 },
  { stepKey: "survey_sent", label: "Post-Completion Survey Sent", order: 4 },
  { stepKey: "final_billing", label: "Final Billing Submitted", order: 5 },
  { stepKey: "docs_archived", label: "Documentation Archived", order: 6 },
] as const;

export async function getCloseoutChecklist(tenantDb: TenantDb, dealId: string) {
  const items = await tenantDb
    .select()
    .from(closeoutChecklistItems)
    .where(eq(closeoutChecklistItems.dealId, dealId))
    .orderBy(closeoutChecklistItems.displayOrder);

  const total = items.length;
  const completed = items.filter((i) => i.isCompleted).length;
  const progress = total > 0 ? Math.round((completed / total) * 100) : 0;

  return { items, progress: { total, completed, percent: progress } };
}

export async function initializeCloseoutChecklist(
  tenantDb: TenantDb,
  dealId: string
) {
  // Check if any items already exist
  const existing = await tenantDb
    .select({ count: sql<number>`count(*)` })
    .from(closeoutChecklistItems)
    .where(eq(closeoutChecklistItems.dealId, dealId));

  if (Number(existing[0]?.count ?? 0) > 0) {
    // Already initialized — return existing
    return getCloseoutChecklist(tenantDb, dealId);
  }

  await tenantDb.insert(closeoutChecklistItems).values(
    DEFAULT_STEPS.map((step) => ({
      dealId,
      stepKey: step.stepKey,
      label: step.label,
      displayOrder: step.order,
    }))
  );

  return getCloseoutChecklist(tenantDb, dealId);
}

export async function toggleChecklistItem(
  tenantDb: TenantDb,
  itemId: string,
  dealId: string,
  userId: string
) {
  const [existing] = await tenantDb
    .select()
    .from(closeoutChecklistItems)
    .where(and(eq(closeoutChecklistItems.id, itemId), eq(closeoutChecklistItems.dealId, dealId)))
    .limit(1);

  if (!existing) throw new AppError(404, "Checklist item not found");

  const nowCompleted = !existing.isCompleted;

  const result = await tenantDb
    .update(closeoutChecklistItems)
    .set({
      isCompleted: nowCompleted,
      completedAt: nowCompleted ? new Date() : null,
      completedBy: nowCompleted ? userId : null,
    })
    .where(and(eq(closeoutChecklistItems.id, itemId), eq(closeoutChecklistItems.dealId, dealId)))
    .returning();

  return result[0];
}

export async function updateChecklistItem(
  tenantDb: TenantDb,
  itemId: string,
  dealId: string,
  userId: string,
  updates: { isCompleted?: boolean; notes?: string }
) {
  const [existing] = await tenantDb
    .select()
    .from(closeoutChecklistItems)
    .where(and(eq(closeoutChecklistItems.id, itemId), eq(closeoutChecklistItems.dealId, dealId)))
    .limit(1);

  if (!existing) throw new AppError(404, "Checklist item not found");

  const patch: Record<string, any> = {};

  if (updates.isCompleted !== undefined) {
    const nowCompleted = updates.isCompleted;
    patch.isCompleted = nowCompleted;
    patch.completedAt = nowCompleted ? new Date() : null;
    patch.completedBy = nowCompleted ? userId : null;
  }

  if (updates.notes !== undefined) {
    patch.notes = updates.notes;
  }

  if (Object.keys(patch).length === 0) return existing;

  const result = await tenantDb
    .update(closeoutChecklistItems)
    .set(patch)
    .where(and(eq(closeoutChecklistItems.id, itemId), eq(closeoutChecklistItems.dealId, dealId)))
    .returning();

  return result[0];
}

export async function isCloseoutComplete(tenantDb: TenantDb, dealId: string): Promise<boolean> {
  const items = await tenantDb
    .select()
    .from(closeoutChecklistItems)
    .where(eq(closeoutChecklistItems.dealId, dealId));

  if (items.length === 0) return false;
  return items.every((i) => i.isCompleted);
}
