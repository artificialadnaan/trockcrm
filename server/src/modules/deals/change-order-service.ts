import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { dealChangeOrders, deals, pipelineStageConfig } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import { isGenuineWonDealStageSlug, type WorkflowRoute } from "@trock-crm/shared/types";
import { WON_STAGE_SLUGS } from "../shared/pipeline-terminal-stages.js";
import { generateDealNumberForProject } from "../../services/projectNumber.js";
import { writeAuditLog } from "../../lib/audit-log.js";
import { calculateCommissionForDeal } from "../commissions/service.js";
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

interface ParentForChildCreate {
  id: string;
  name: string;
  isBidBoardOwned: boolean;
  workflowRoute: WorkflowRoute | null;
  stageId: string;
  stageSlug: string | null;
  companyId: string | null;
  propertyId: string | null;
  assignedRepId: string | null;
  projectNumber: string | null;
  officeCode: string | null;
  projectType: string | null;
  projectTypeId: string | null;
  regionId: string | null;
}

// Load the parent deal (with the fields a CO child inherits) and assert eligibility in one pass.
async function loadParentForChildCreate(
  tenantDb: TenantDb,
  dealId: string
): Promise<ParentForChildCreate> {
  const [row] = await tenantDb
    .select({
      id: deals.id,
      name: deals.name,
      isBidBoardOwned: deals.isBidBoardOwned,
      workflowRoute: deals.workflowRoute,
      stageId: deals.stageId,
      stageSlug: pipelineStageConfig.slug,
      companyId: deals.companyId,
      propertyId: deals.propertyId,
      assignedRepId: deals.assignedRepId,
      projectNumber: deals.projectNumber,
      officeCode: deals.officeCode,
      projectType: deals.projectType,
      projectTypeId: deals.projectTypeId,
      regionId: deals.regionId,
    })
    .from(deals)
    .leftJoin(pipelineStageConfig, eq(pipelineStageConfig.id, deals.stageId))
    .where(eq(deals.id, dealId))
    .limit(1);

  if (!row) {
    throw new AppError(404, "Deal not found");
  }
  const eligible =
    row.isBidBoardOwned === true || isGenuineWonDealStageSlug(row.stageSlug, row.workflowRoute);
  if (!eligible) {
    throw new AppError(
      409,
      "Change orders can only be added to Won or Bid-Board-owned deals.",
      "DEAL_NOT_CHANGE_ORDER_ELIGIBLE"
    );
  }
  return row as ParentForChildCreate;
}

// The CO child is always Won. Prefer the parent's own stage when it is genuinely Won (the common case);
// otherwise (a Bid-Board-Owned parent that isn't in a Won stage) resolve a canonical Won stage so the
// child still counts — it must never be born outside a Won stage (silent-vanish guard).
async function resolveChildWonStage(
  tenantDb: TenantDb,
  parent: ParentForChildCreate
): Promise<{ id: string; slug: string }> {
  if (parent.stageSlug && isGenuineWonDealStageSlug(parent.stageSlug, parent.workflowRoute)) {
    return { id: parent.stageId, slug: parent.stageSlug };
  }
  const [won] = await tenantDb
    .select({ id: pipelineStageConfig.id, slug: pipelineStageConfig.slug })
    .from(pipelineStageConfig)
    .where(inArray(pipelineStageConfig.slug, [...WON_STAGE_SLUGS]))
    .orderBy(asc(pipelineStageConfig.displayOrder))
    .limit(1);
  if (!won) {
    throw new AppError(
      500,
      "No Won stage is configured to create a change-order child deal.",
      "CHANGE_ORDER_WON_STAGE_MISSING"
    );
  }
  return won;
}

// 1-based ordinal for the child's display name ("… — Change Order N").
async function nextChildOrdinal(tenantDb: TenantDb, parentDealId: string): Promise<number> {
  const [row] = await tenantDb
    .select({ n: sql<number>`COUNT(*)::int` })
    .from(deals)
    .where(and(eq(deals.parentDealId, parentDealId), eq(deals.isChangeOrder, true)));
  return Number(row?.n ?? 0) + 1;
}

export interface CreateChangeOrderChildInput {
  parentDealId: string;
  signedDate: unknown;
  amount: unknown;
  description?: unknown;
  createdBy?: string | null;
}

/**
 * Create a change order as its own real CHILD deal: stage = Won, won_closed_date = the CO's date,
 * awarded_amount = the CO amount, parent_deal_id + is_change_order set, company/property/rep inherited,
 * sharing the parent's project_number (the unique index exempts is_change_order rows). CRM-only — it is
 * never synced to Bid Board/Procore, and geocode + assignment-task side-effects are intentionally NOT
 * fired for a child. Commission is wired by the caller (addDealChangeOrder), per the comp decision.
 *
 * SILENT-VANISH GUARD (hard): every child is created with a Won stage + a usable won date + a positive
 * awarded amount + not on-hold + not test-data — the exact set every Won total requires. We control all
 * of these and assert the load-bearing ones before insert, so a child can never be born in a state that
 * drops it out of the Won reports/counts.
 */
export async function createChangeOrderChildDeal(
  tenantDb: TenantDb,
  input: CreateChangeOrderChildInput
): Promise<ChangeOrderRecord> {
  const parent = await loadParentForChildCreate(tenantDb, input.parentDealId);
  const amount = normalizeChangeOrderAmount(input.amount);
  const signedDate = normalizeSignedDate(input.signedDate);
  const description = normalizeDescription(input.description);
  const wonStage = await resolveChildWonStage(tenantDb, parent);

  // Hard silent-vanish asserts (defensive — all of these are values we set/resolve above).
  if (!isGenuineWonDealStageSlug(wonStage.slug, parent.workflowRoute)) {
    throw new AppError(
      500,
      "Refusing to create a change-order child outside a Won stage.",
      "CHANGE_ORDER_CHILD_NOT_WON"
    );
  }
  if (!signedDate || !(Number(amount) > 0)) {
    throw new AppError(
      500,
      "Refusing to create a change-order child without a won date and positive amount.",
      "CHANGE_ORDER_CHILD_INVALID"
    );
  }

  const ordinal = await nextChildOrdinal(tenantDb, parent.id);
  const createdAt = new Date();
  const dealNumber = await generateDealNumberForProject(tenantDb, {
    id: "new",
    officeCode: parent.officeCode,
    projectType: parent.projectType,
    workflowRoute: parent.workflowRoute ?? "normal",
    createdAt,
  });

  // Explicit column list (not drizzle .values, which emits every schema column): a CO child sets only
  // these; everything else takes its DB default. CRM-only — no source lead, no geocode, no assignment
  // task. The child shares the parent's project_number (the unique index exempts is_change_order rows).
  const childName = `${parent.name} — Change Order ${ordinal}`;
  const inserted = await tenantDb.execute(sql`
    INSERT INTO deals (
      deal_number, name, stage_id, is_change_order, parent_deal_id, assigned_rep_id, company_id, property_id,
      awarded_amount, won_closed_date, contract_signed_date, project_number, office_code, project_type,
      project_type_id, region_id, source, description, created_by_user_id, workflow_route,
      is_active, on_hold, is_test_data, stage_entered_at, created_at, updated_at
    ) VALUES (
      ${dealNumber}, ${childName}, ${wonStage.id}, true, ${parent.id}, ${parent.assignedRepId},
      ${parent.companyId}, ${parent.propertyId}, ${amount}, ${signedDate}, ${signedDate},
      ${parent.projectNumber}, ${parent.officeCode}, ${parent.projectType}, ${parent.projectTypeId},
      ${parent.regionId}, 'change_order', ${description}, ${input.createdBy ?? null},
      ${parent.workflowRoute ?? "normal"}, true, false, false, ${createdAt}, ${createdAt}, ${createdAt}
    )
    RETURNING id, deal_number, created_at, updated_at
  `);
  const childRow = (
    (Array.isArray(inserted) ? inserted : (inserted as { rows?: unknown[] }).rows ?? []) as Array<{
      id: string;
      deal_number: string;
      created_at: Date | string;
      updated_at: Date | string;
    }>
  )[0];

  await writeAuditLog(tenantDb, {
    tableName: "deals",
    recordId: childRow.id,
    action: "insert",
    changedBy: input.createdBy ?? null,
    entityType: "deal",
    fullRow: {
      id: childRow.id,
      dealNumber: childRow.deal_number,
      isChangeOrder: true,
      parentDealId: parent.id,
      awardedAmount: amount,
      wonClosedDate: signedDate,
    },
  });

  // Return the API ChangeOrderRecord shape (dealId = the PARENT), so the routes + #642 Estimates card
  // keep working unchanged while the value lives in the child deal.
  return {
    id: childRow.id,
    dealId: parent.id,
    signedDate,
    amount,
    description,
    createdBy: input.createdBy ?? null,
    updatedBy: input.createdBy ?? null,
    createdAt: childRow.created_at,
    updatedAt: childRow.updated_at,
  };
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

// Columns drizzle selects for a CO child deal, mapped to the ChangeOrderRecord API shape.
const childChangeOrderColumns = {
  id: deals.id,
  dealId: deals.parentDealId,
  signedDate: deals.wonClosedDate,
  amount: deals.awardedAmount,
  description: deals.description,
  createdBy: deals.createdByUserId,
  createdAt: deals.createdAt,
  updatedAt: deals.updatedAt,
} as const;

interface ChildCoRow {
  id: string;
  dealId: string | null;
  signedDate: string | null;
  amount: string | null;
  description: string | null;
  createdBy: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

function childRowToChangeOrderRecord(r: ChildCoRow): ChangeOrderRecord {
  return {
    id: r.id,
    dealId: r.dealId ?? "",
    signedDate: r.signedDate ?? "",
    amount: r.amount ?? "0",
    description: r.description,
    createdBy: r.createdBy,
    updatedBy: null, // CO children don't track a separate updatedBy; edits are admin-only.
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

// A change order's value lives in its child deal (new model). During the migration window, some COs may
// still be legacy deal_change_orders rows (until PR4 converts them). The reads below return the UNION —
// each CO appears EXACTLY ONCE (a CO is a child OR a legacy row, never both; PR4 deletes the row as it
// creates the child), so totals never double-count and never vanish.
export async function listDealChangeOrders(
  tenantDb: TenantDb,
  dealId: string
): Promise<ChangeOrderRecord[]> {
  const childRows = (await tenantDb
    .select(childChangeOrderColumns)
    .from(deals)
    .where(and(eq(deals.parentDealId, dealId), eq(deals.isChangeOrder, true)))) as ChildCoRow[];
  const legacyRows = (await tenantDb
    .select()
    .from(dealChangeOrders)
    .where(eq(dealChangeOrders.dealId, dealId))) as ChangeOrderRecord[];
  const records = [...childRows.map(childRowToChangeOrderRecord), ...legacyRows];
  records.sort(
    (a, b) =>
      String(b.signedDate).localeCompare(String(a.signedDate)) ||
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
  return records;
}

export async function getDealChangeOrderById(
  tenantDb: TenantDb,
  id: string,
  dealId: string
): Promise<ChangeOrderRecord | null> {
  const [child] = (await tenantDb
    .select(childChangeOrderColumns)
    .from(deals)
    .where(and(eq(deals.id, id), eq(deals.parentDealId, dealId), eq(deals.isChangeOrder, true)))
    .limit(1)) as ChildCoRow[];
  if (child) return childRowToChangeOrderRecord(child);
  const [legacy] = await tenantDb
    .select()
    .from(dealChangeOrders)
    .where(and(eq(dealChangeOrders.id, id), eq(dealChangeOrders.dealId, dealId)))
    .limit(1);
  return (legacy as ChangeOrderRecord) ?? null;
}

/** Sum of a deal's change-order value (child deals + un-migrated legacy rows), cent-exact, counted once. */
export async function sumDealChangeOrders(tenantDb: TenantDb, dealId: string): Promise<string> {
  // Wide numeric(38,2): each row is bounded to the per-row ceiling, but a multi-CO sum can exceed it.
  const result = await tenantDb.execute(sql`
    SELECT (
      (SELECT COALESCE(SUM(awarded_amount), 0) FROM deals WHERE parent_deal_id = ${dealId} AND is_change_order = true)
      + (SELECT COALESCE(SUM(amount), 0) FROM deal_change_orders WHERE deal_id = ${dealId})
    )::numeric(38,2) AS total
  `);
  const rows = (Array.isArray(result) ? result : (result as { rows?: Array<{ total?: string }> }).rows ?? []);
  return rows[0]?.total ?? "0";
}

export async function addDealChangeOrder(
  tenantDb: TenantDb,
  input: AddChangeOrderInput
): Promise<ChangeOrderRecord> {
  const record = await createChangeOrderChildDeal(tenantDb, {
    parentDealId: input.dealId,
    signedDate: input.signedDate,
    amount: input.amount,
    description: input.description,
    createdBy: input.createdBy,
  });
  // A change order is signed work, so the rep earns commission on it (decision: COs earn commission).
  // Resilient: a commission-config gap must never block creating the CO child — log and continue.
  if (input.createdBy) {
    try {
      await calculateCommissionForDeal(tenantDb, {
        dealId: record.id,
        contractSignedDate: record.signedDate,
        triggeredByUserId: input.createdBy,
      });
    } catch (err) {
      console.error(`[ChangeOrders] commission calc failed for CO child ${record.id}:`, err);
    }
  }
  return record;
}

export async function updateDealChangeOrder(
  tenantDb: TenantDb,
  input: UpdateChangeOrderInput
): Promise<ChangeOrderRecord> {
  // Child deal (new model) first.
  const childUpdates: Record<string, unknown> = { updatedAt: new Date() };
  if (input.amount !== undefined) childUpdates.awardedAmount = normalizeChangeOrderAmount(input.amount);
  if (input.signedDate !== undefined) childUpdates.wonClosedDate = normalizeSignedDate(input.signedDate);
  if (input.description !== undefined) childUpdates.description = normalizeDescription(input.description);
  const [child] = (await tenantDb
    .update(deals)
    .set(childUpdates)
    .where(and(eq(deals.id, input.id), eq(deals.parentDealId, input.dealId), eq(deals.isChangeOrder, true)))
    .returning(childChangeOrderColumns)) as ChildCoRow[];
  if (child) return childRowToChangeOrderRecord(child);

  // Legacy fallback: an un-migrated deal_change_orders row.
  const legacyUpdates: Record<string, unknown> = {
    updatedAt: new Date(),
    updatedBy: input.updatedBy ?? null,
  };
  if (input.amount !== undefined) legacyUpdates.amount = normalizeChangeOrderAmount(input.amount);
  if (input.signedDate !== undefined) legacyUpdates.signedDate = normalizeSignedDate(input.signedDate);
  if (input.description !== undefined) legacyUpdates.description = normalizeDescription(input.description);
  const [legacy] = await tenantDb
    .update(dealChangeOrders)
    .set(legacyUpdates)
    .where(and(eq(dealChangeOrders.id, input.id), eq(dealChangeOrders.dealId, input.dealId)))
    .returning();
  if (!legacy) {
    throw new AppError(404, "Change order not found");
  }
  return legacy as ChangeOrderRecord;
}

export async function deleteDealChangeOrder(
  tenantDb: TenantDb,
  input: { id: string; dealId: string }
): Promise<ChangeOrderRecord> {
  // Deleting a CO child removes its deal row. Try the child first, then a legacy row.
  const [child] = (await tenantDb
    .delete(deals)
    .where(and(eq(deals.id, input.id), eq(deals.parentDealId, input.dealId), eq(deals.isChangeOrder, true)))
    .returning(childChangeOrderColumns)) as ChildCoRow[];
  if (child) return childRowToChangeOrderRecord(child);

  const [legacy] = await tenantDb
    .delete(dealChangeOrders)
    .where(and(eq(dealChangeOrders.id, input.id), eq(dealChangeOrders.dealId, input.dealId)))
    .returning();
  if (!legacy) {
    throw new AppError(404, "Change order not found");
  }
  return legacy as ChangeOrderRecord;
}
