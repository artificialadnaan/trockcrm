import { eq, and, inArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { workflowTimers } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import { AppError } from "../../middleware/error-handler.js";

type TenantDb = NodePgDatabase<typeof schema>;

export interface CreateTimerInput {
  dealId: string;
  timerType: string;
  label?: string;
  deadlineAt: Date | string;
  createdBy?: string;
}

export async function getTimers(tenantDb: TenantDb, dealId: string) {
  const timers = await tenantDb
    .select()
    .from(workflowTimers)
    .where(eq(workflowTimers.dealId, dealId))
    .orderBy(workflowTimers.createdAt);

  const active = timers.filter((t) => t.status === "active");
  const recent = timers.filter((t) => t.status !== "active");

  return { active, recent, all: timers };
}

export async function createTimer(tenantDb: TenantDb, input: CreateTimerInput) {
  if (!input.dealId) throw new AppError(400, "dealId is required");
  if (!input.timerType) throw new AppError(400, "timerType is required");
  if (!input.deadlineAt) throw new AppError(400, "deadlineAt is required");

  const result = await tenantDb
    .insert(workflowTimers)
    .values({
      dealId: input.dealId,
      timerType: input.timerType as any,
      label: input.label ?? null,
      deadlineAt: new Date(input.deadlineAt),
      createdBy: input.createdBy ?? null,
    })
    .returning();

  return result[0];
}

export async function completeTimer(tenantDb: TenantDb, timerId: string, dealId: string) {
  const result = await tenantDb
    .update(workflowTimers)
    .set({ status: "completed", completedAt: new Date() })
    .where(and(eq(workflowTimers.id, timerId), eq(workflowTimers.dealId, dealId)))
    .returning();

  if (result.length === 0) throw new AppError(404, "Timer not found");
  return result[0];
}

export async function cancelTimer(tenantDb: TenantDb, timerId: string, dealId: string) {
  const result = await tenantDb
    .update(workflowTimers)
    .set({ status: "cancelled" })
    .where(and(eq(workflowTimers.id, timerId), eq(workflowTimers.dealId, dealId)))
    .returning();

  if (result.length === 0) throw new AppError(404, "Timer not found");
  return result[0];
}

/**
 * Auto-create stage-specific timers when a deal enters certain stages.
 * - 'estimating'  → 14-day estimate_review timer
 * - 'bid_sent'    → 48hr proposal_response timer
 * - 'close_out'   → 5-day final_billing timer
 */
export async function createStageTimers(
  tenantDb: TenantDb,
  dealId: string,
  stageSlug: string,
  userId: string
): Promise<void> {
  const now = new Date();

  const timerSpec = getTimerSpecForStage(stageSlug);
  if (!timerSpec) return;

  const deadlineAt = new Date(now.getTime() + timerSpec.durationMs);

  await tenantDb.insert(workflowTimers).values({
    dealId,
    timerType: timerSpec.timerType as any,
    label: timerSpec.label,
    deadlineAt,
    createdBy: userId,
  });
}

function getTimerSpecForStage(
  stageSlug: string
): { timerType: string; label: string; durationMs: number } | null {
  switch (stageSlug) {
    case "estimating":
      return {
        timerType: "estimate_review",
        label: "Estimate Review Due",
        durationMs: 14 * 24 * 60 * 60 * 1000, // 14 days
      };
    case "bid_sent":
      return {
        timerType: "proposal_response",
        label: "Proposal Response Due",
        durationMs: 48 * 60 * 60 * 1000, // 48 hours
      };
    case "close_out":
      return {
        timerType: "final_billing",
        label: "Final Billing Due",
        durationMs: 5 * 24 * 60 * 60 * 1000, // 5 days
      };
    default:
      return null;
  }
}

export async function getActiveTimerCount(tenantDb: TenantDb, dealId: string): Promise<number> {
  const result = await tenantDb
    .select({ count: sql<number>`count(*)` })
    .from(workflowTimers)
    .where(
      and(eq(workflowTimers.dealId, dealId), eq(workflowTimers.status, "active"))
    );

  return Number(result[0]?.count ?? 0);
}
