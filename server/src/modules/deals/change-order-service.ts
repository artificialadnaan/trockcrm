import { and, desc, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { dealChangeOrders, deals, pipelineStageConfig } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import { isGenuineWonDealStageSlug } from "@trock-crm/shared/types";
import { AppError } from "../../middleware/error-handler.js";

type TenantDb = NodePgDatabase<typeof schema>;

export interface ChangeOrderRecord {
  id: string;
  dealId: string;
  signedDate: string;
  amount: string;
  description: string | null;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface AddChangeOrderInput {
  dealId: string;
  signedDate: unknown;
  amount: unknown;
  description?: unknown;
  createdBy?: string | null;
}

export interface UpdateChangeOrderInput {
  id: string;
  dealId: string;
  signedDate?: unknown;
  amount?: unknown;
  description?: unknown;
  updatedBy?: string | null;
}

/**
 * Eligibility gate: a CRM change order may only be attached to a deal that is Won-family OR
 * Bid-Board-Owned — the same canonical checks the rest of the platform uses to identify a Won /
 * sent-to-Bid-Board deal. Throws 404 if the deal does not exist, 409 if it is not eligible.
 */
export async function assertDealEligibleForChangeOrder(
  tenantDb: TenantDb,
  dealId: string
): Promise<{ id: string }> {
  const [row] = await tenantDb
    .select({
      id: deals.id,
      isBidBoardOwned: deals.isBidBoardOwned,
      workflowRoute: deals.workflowRoute,
      stageSlug: pipelineStageConfig.slug,
    })
    .from(deals)
    .leftJoin(pipelineStageConfig, eq(pipelineStageConfig.id, deals.stageId))
    .where(eq(deals.id, dealId))
    .limit(1);

  if (!row) {
    throw new AppError(404, "Deal not found");
  }

  const eligible =
    row.isBidBoardOwned === true ||
    isGenuineWonDealStageSlug(row.stageSlug, row.workflowRoute);

  if (!eligible) {
    throw new AppError(
      409,
      "Change orders can only be added to Won or Bid-Board-owned deals.",
      "DEAL_NOT_CHANGE_ORDER_ELIGIBLE"
    );
  }

  return { id: row.id };
}

// Positive money string: 1-12 integer digits + up to 2 decimals. This bounds the value to the
// deal_change_orders.amount NUMERIC(14,2) ceiling (999,999,999,999.99) by construction.
const CHANGE_ORDER_AMOUNT_PATTERN = /^\d{1,12}(\.\d{1,2})?$/;

/**
 * Validate + normalize a change-order amount to a positive 2-decimal numeric string.
 *
 * Decimal-safe by construction: it validates the string form (at most 2 decimals, at most 12 integer
 * digits) and formats via string padding — never via Number.toFixed rounding. So sub-cent inputs
 * (would round to 0.00 and trip the DB CHECK > 0), extra-precision inputs (would silently round the
 * stored value), and over-ceiling inputs (would overflow NUMERIC(14,2)) are all rejected as a clean
 * 400 rather than surfacing later as a DB 500.
 */
export function normalizeChangeOrderAmount(input: unknown): string {
  const raw =
    typeof input === "number"
      ? Number.isFinite(input)
        ? String(input)
        : ""
      : typeof input === "string"
        ? input.trim()
        : "";
  if (!CHANGE_ORDER_AMOUNT_PATTERN.test(raw)) {
    throw new AppError(
      400,
      "Change order amount must be a positive number with at most 2 decimals (max 999,999,999,999.99).",
      "CHANGE_ORDER_AMOUNT_INVALID"
    );
  }
  if (Number(raw) <= 0) {
    throw new AppError(
      400,
      "Change order amount must be greater than 0.",
      "CHANGE_ORDER_AMOUNT_INVALID"
    );
  }
  const [intPart, fraction = ""] = raw.split(".");
  return `${intPart}.${fraction.padEnd(2, "0")}`;
}

function normalizeSignedDate(input: unknown): string {
  if (typeof input !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(input.trim())) {
    throw new AppError(
      400,
      "Change order signed date must be a valid YYYY-MM-DD date.",
      "CHANGE_ORDER_SIGNED_DATE_INVALID"
    );
  }
  const trimmed = input.trim();
  const parsed = new Date(`${trimmed}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== trimmed) {
    throw new AppError(
      400,
      "Change order signed date is not a real calendar date.",
      "CHANGE_ORDER_SIGNED_DATE_INVALID"
    );
  }
  return trimmed;
}

function normalizeDescription(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function listDealChangeOrders(
  tenantDb: TenantDb,
  dealId: string
): Promise<ChangeOrderRecord[]> {
  return tenantDb
    .select()
    .from(dealChangeOrders)
    .where(eq(dealChangeOrders.dealId, dealId))
    .orderBy(desc(dealChangeOrders.signedDate), desc(dealChangeOrders.createdAt)) as Promise<
    ChangeOrderRecord[]
  >;
}

export async function getDealChangeOrderById(
  tenantDb: TenantDb,
  id: string,
  dealId: string
): Promise<ChangeOrderRecord | null> {
  const [row] = await tenantDb
    .select()
    .from(dealChangeOrders)
    .where(and(eq(dealChangeOrders.id, id), eq(dealChangeOrders.dealId, dealId)))
    .limit(1);
  return (row as ChangeOrderRecord) ?? null;
}

/** Sum of a deal's CRM change-order amounts, computed in SQL for cent-exact precision. */
export async function sumDealChangeOrders(tenantDb: TenantDb, dealId: string): Promise<string> {
  // Cast to a WIDE numeric, not numeric(14,2): each row is bounded to the per-row ceiling, but a deal
  // with many change orders can have a SUM that exceeds it — recasting to numeric(14,2) here would
  // overflow the read path (deal load / list) even though every row is individually valid.
  const [row] = await tenantDb
    .select({
      total: sql<string>`COALESCE(SUM(${dealChangeOrders.amount}), 0)::numeric(38,2)`,
    })
    .from(dealChangeOrders)
    .where(eq(dealChangeOrders.dealId, dealId));
  return row?.total ?? "0";
}

export async function addDealChangeOrder(
  tenantDb: TenantDb,
  input: AddChangeOrderInput
): Promise<ChangeOrderRecord> {
  await assertDealEligibleForChangeOrder(tenantDb, input.dealId);
  const amount = normalizeChangeOrderAmount(input.amount);
  const signedDate = normalizeSignedDate(input.signedDate);
  const description = normalizeDescription(input.description);

  const [row] = await tenantDb
    .insert(dealChangeOrders)
    .values({
      dealId: input.dealId,
      signedDate,
      amount,
      description,
      createdBy: input.createdBy ?? null,
      updatedBy: input.createdBy ?? null,
    })
    .returning();
  return row as ChangeOrderRecord;
}

export async function updateDealChangeOrder(
  tenantDb: TenantDb,
  input: UpdateChangeOrderInput
): Promise<ChangeOrderRecord> {
  const updates: Record<string, unknown> = {
    updatedAt: new Date(),
    updatedBy: input.updatedBy ?? null,
  };
  if (input.amount !== undefined) {
    updates.amount = normalizeChangeOrderAmount(input.amount);
  }
  if (input.signedDate !== undefined) {
    updates.signedDate = normalizeSignedDate(input.signedDate);
  }
  if (input.description !== undefined) {
    updates.description = normalizeDescription(input.description);
  }

  const [row] = await tenantDb
    .update(dealChangeOrders)
    .set(updates)
    .where(and(eq(dealChangeOrders.id, input.id), eq(dealChangeOrders.dealId, input.dealId)))
    .returning();
  if (!row) {
    throw new AppError(404, "Change order not found");
  }
  return row as ChangeOrderRecord;
}

export async function deleteDealChangeOrder(
  tenantDb: TenantDb,
  input: { id: string; dealId: string }
): Promise<ChangeOrderRecord> {
  const [row] = await tenantDb
    .delete(dealChangeOrders)
    .where(and(eq(dealChangeOrders.id, input.id), eq(dealChangeOrders.dealId, input.dealId)))
    .returning();
  if (!row) {
    throw new AppError(404, "Change order not found");
  }
  return row as ChangeOrderRecord;
}
