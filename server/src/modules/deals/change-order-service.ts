import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { dealChangeOrders, deals, pipelineStageConfig, tasks } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import { isGenuineWonDealStageSlug, type WorkflowRoute } from "@trock-crm/shared/types";
import { WON_STAGE_SLUGS } from "../shared/pipeline-terminal-stages.js";
import { generateDealNumberForProject } from "../../services/projectNumber.js";
import { writeAuditLog } from "../../lib/audit-log.js";
import {
  calculateCommissionForDeal,
  recalculateCommissionForDeal,
  removeCommissionForDeal,
} from "../commissions/service.js";
import { AppError } from "../../middleware/error-handler.js";
import { recordDescriptionHistoryChange } from "./deal-description-history.js";

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
  // Discriminator for the transition window (children ∪ un-migrated legacy rows): the real child deal's
  // id when this CO is a child deal (deep-linkable to /deals/{childDealId}), null for a legacy
  // deal_change_orders row (no deal to link). Naturally all-non-null once PR4 migrates the legacy rows.
  childDealId: string | null;
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
  pipelineTypeSnapshot: string; // NOT NULL in schema (default 'normal')
  estimatorUserId: string | null;
  salesSourceUserId: string | null;
  isActive: boolean;
  isTestData: boolean;
}

// Load the parent deal (with the fields a CO child inherits) and assert eligibility in one pass.
async function loadParentForChildCreate(
  tenantDb: TenantDb,
  dealId: string
): Promise<ParentForChildCreate> {
  // Lock the parent row FOR UPDATE before the eligibility read so a concurrent parent-delete serializes
  // against this create (deleteDeal takes the same lock). Raw SQL — FOR UPDATE can't be applied to the
  // nullable side of the pipelineStageConfig LEFT JOIN below. Closes the race where a delete cascades
  // before this child exists, orphaning an active Won CO under a now-deleted parent.
  await tenantDb.execute(sql`SELECT id FROM deals WHERE id = ${dealId} FOR UPDATE`);
  const [row] = await tenantDb
    .select({
      id: deals.id,
      name: deals.name,
      isBidBoardOwned: deals.isBidBoardOwned,
      isChangeOrder: deals.isChangeOrder,
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
      // Inherit the parent's reporting classification so a CO of a service deal classifies as service
      // (not the default 'normal') and an estimator-attributed CO still appears in estimator-filtered reports.
      pipelineTypeSnapshot: deals.pipelineTypeSnapshot,
      estimatorUserId: deals.estimatorUserId,
      // Inherit the parent's sales source so the CO child shows the correct source attribution
      // in the UI ("Not set" is visible when salesSourceUserId is null but parent has a source).
      salesSourceUserId: deals.salesSourceUserId,
      isActive: deals.isActive,
      isTestData: deals.isTestData,
    })
    .from(deals)
    .leftJoin(pipelineStageConfig, eq(pipelineStageConfig.id, deals.stageId))
    .where(eq(deals.id, dealId))
    .limit(1);

  if (!row) {
    throw new AppError(404, "Deal not found");
  }
  // A soft-deleted (or never-active) parent must not spawn a CO child: the child would be born an active
  // Won deal under a removed parent and surface independently in active lists/search/Won reports.
  if (row.isActive === false) {
    throw new AppError(
      409,
      "Change orders cannot be added to a deleted deal.",
      "DEAL_NOT_CHANGE_ORDER_ELIGIBLE"
    );
  }
  // One-level invariant: a CO child is itself a Won deal (so it would PASS the eligibility check below),
  // but change orders must never nest — reject adding a CO to another CO.
  if (row.isChangeOrder === true) {
    throw new AppError(
      409,
      "A change order cannot be added to another change order.",
      "DEAL_IS_CHANGE_ORDER"
    );
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
  // Constrain the fallback to the PARENT'S workflow family so a normal parent can't nondeterministically
  // get a service Won stage (or vice versa) — both families' Won stages can be active with the same display
  // order, and the child must land on the board/family its inherited workflow_route belongs to.
  const family: "service_deal" | "standard_deal" =
    (parent.workflowRoute ?? "normal") === "service" ? "service_deal" : "standard_deal";
  const [won] = await tenantDb
    .select({ id: pipelineStageConfig.id, slug: pipelineStageConfig.slug })
    .from(pipelineStageConfig)
    .where(
      and(
        eq(pipelineStageConfig.workflowFamily, family),
        inArray(pipelineStageConfig.slug, [...WON_STAGE_SLUGS])
      )
    )
    // Prefer an ACTIVE-pipeline Won stage (don't resolve a child into a deprecated stage); fall back to
    // any Won stage in the family if none is active.
    .orderBy(desc(pipelineStageConfig.isActivePipeline), asc(pipelineStageConfig.displayOrder))
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
  // Bound the generated name to deals.name's varchar(500): a near-limit parent name + the suffix would
  // otherwise overflow the column and fail the insert with a DB error, blocking COs on long-named deals.
  const childNameSuffix = ` — Change Order ${ordinal}`;
  const childName = `${parent.name}${childNameSuffix}`.length > 500
    ? `${parent.name.slice(0, 500 - childNameSuffix.length)}${childNameSuffix}`
    : `${parent.name}${childNameSuffix}`;
  // Suppress the project-number-first-set email (migration 0138 trigger) for this insert: a CO child
  // shares the parent's project_number, so it is NOT a first project-number assignment. Transaction-local
  // (the per-request connection runs in one transaction — middleware/tenant.ts), reset right after the
  // insert so other writes in the same request still notify normally. A no-op in PGlite auto-commit.
  await tenantDb.execute(sql`SELECT set_config('app.skip_project_number_email', 'true', true)`);
  const inserted = await tenantDb.execute(sql`
    INSERT INTO deals (
      deal_number, name, stage_id, is_change_order, parent_deal_id, assigned_rep_id, company_id, property_id,
      awarded_amount, won_closed_date, contract_signed_date, project_number, office_code, project_type,
      project_type_id, region_id, pipeline_type_snapshot, estimator_user_id, sales_source_user_id, source, description,
      created_by_user_id, workflow_route,
      is_active, on_hold, is_test_data, stage_entered_at, created_at, updated_at
    ) VALUES (
      ${dealNumber}, ${childName}, ${wonStage.id}, true, ${parent.id}, ${parent.assignedRepId},
      ${parent.companyId}, ${parent.propertyId}, ${amount}, ${signedDate}, ${signedDate},
      ${parent.projectNumber}, ${parent.officeCode}, ${parent.projectType}, ${parent.projectTypeId},
      ${parent.regionId}, ${parent.pipelineTypeSnapshot}, ${parent.estimatorUserId}, ${parent.salesSourceUserId}, 'change_order', ${description}, ${input.createdBy ?? null},
      ${parent.workflowRoute ?? "normal"}, true, false, ${parent.isTestData}, ${createdAt}, ${createdAt}, ${createdAt}
    )
    RETURNING id, deal_number, created_at, updated_at
  `);
  await tenantDb.execute(sql`SELECT set_config('app.skip_project_number_email', '', true)`);
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
    childDealId: childRow.id, // a real child deal — deep-linkable to /deals/{id}
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
    childDealId: r.id, // a real child deal — deep-linkable to /deals/{id}
  };
}

// A legacy (un-migrated) deal_change_orders row is value-only: no backing deal, so childDealId is null.
function legacyRowToChangeOrderRecord(r: Record<string, unknown>): ChangeOrderRecord {
  return { ...(r as Omit<ChangeOrderRecord, "childDealId">), childDealId: null };
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
    .where(
      and(eq(deals.parentDealId, dealId), eq(deals.isChangeOrder, true), eq(deals.isActive, true))
    )) as ChildCoRow[];
  const legacyRows = (await tenantDb
    .select()
    .from(dealChangeOrders)
    .where(eq(dealChangeOrders.dealId, dealId))) as Array<Record<string, unknown>>;
  const records = [
    ...childRows.map(childRowToChangeOrderRecord),
    ...legacyRows.map(legacyRowToChangeOrderRecord),
  ];
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
    .where(
      and(
        eq(deals.id, id),
        eq(deals.parentDealId, dealId),
        eq(deals.isChangeOrder, true),
        eq(deals.isActive, true)
      )
    )
    .limit(1)) as ChildCoRow[];
  if (child) return childRowToChangeOrderRecord(child);
  const [legacy] = await tenantDb
    .select()
    .from(dealChangeOrders)
    .where(and(eq(dealChangeOrders.id, id), eq(dealChangeOrders.dealId, dealId)))
    .limit(1);
  return legacy ? legacyRowToChangeOrderRecord(legacy as Record<string, unknown>) : null;
}

// Add two non-negative money strings ("<int>.<2dp>" or integer) as integer cents via BigInt — exact at
// ANY magnitude (no IEEE-754 rounding even for a pathological multi-CO total beyond 2^53 cents).
function addMoneyStrings(a: string, b: string): string {
  const toCents = (s: string): bigint => {
    const [intPart, frac = ""] = s.split(".");
    return BigInt(intPart || "0") * 100n + BigInt((frac + "00").slice(0, 2) || "0");
  };
  const cents = toCents(a) + toCents(b);
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
}

/** Sum of a deal's change-order value (child deals + un-migrated legacy rows), counted exactly once. */
export async function sumDealChangeOrders(tenantDb: TenantDb, dealId: string): Promise<string> {
  // Two SQL sums (each wide numeric(38,2), cent-exact) added once. Uses .select (not .execute) so it
  // composes with the same query surface as listDealChangeOrders. A CO is a child OR a legacy row, never
  // both (PR4 converts row→child atomically), so adding the two sums counts every CO exactly once. The
  // cross-source add is done in integer cents (BigInt) so it stays cent-exact at any magnitude.
  const [childSum] = await tenantDb
    .select({ total: sql<string>`COALESCE(SUM(${deals.awardedAmount}), 0)::numeric(38,2)` })
    .from(deals)
    .where(
      and(eq(deals.parentDealId, dealId), eq(deals.isChangeOrder, true), eq(deals.isActive, true))
    );
  const [legacySum] = await tenantDb
    .select({ total: sql<string>`COALESCE(SUM(${dealChangeOrders.amount}), 0)::numeric(38,2)` })
    .from(dealChangeOrders)
    .where(eq(dealChangeOrders.dealId, dealId));
  return addMoneyStrings(childSum?.total ?? "0", legacySum?.total ?? "0");
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
  if (input.signedDate !== undefined) {
    const normalized = normalizeSignedDate(input.signedDate);
    // Keep BOTH signed-date fields in sync, exactly as createChangeOrderChildDeal sets them — else an
    // edit would leave contract_signed_date stale vs won_closed_date.
    childUpdates.wonClosedDate = normalized;
    childUpdates.contractSignedDate = normalized;
  }
  if (input.description !== undefined) childUpdates.description = normalizeDescription(input.description);

  // Capture the child CO's current description before the update so the edit can be logged (a CO child has
  // its own deal detail page + description-history panel). Only when a description edit is actually happening.
  // Read FOR UPDATE so two concurrent CO description edits can't both capture the same old value and log a
  // stale intermediate (A->C instead of B->C) — same serialization the other description-history paths use.
  let previousChildDescription: string | null | undefined;
  if (input.description !== undefined && input.updatedBy) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const childDescQuery = (tenantDb
      .select({ description: deals.description })
      .from(deals)
      .where(
        and(
          eq(deals.id, input.id),
          eq(deals.parentDealId, input.dealId),
          eq(deals.isChangeOrder, true),
          eq(deals.isActive, true)
        )
      )
      .limit(1)) as any;
    const [existingChild] = (typeof childDescQuery.for === "function"
      ? await childDescQuery.for("update")
      : await childDescQuery) as Array<{ description: string | null }>;
    previousChildDescription = existingChild?.description ?? null;
  }

  const [child] = (await tenantDb
    .update(deals)
    .set(childUpdates)
    .where(
      and(
        eq(deals.id, input.id),
        eq(deals.parentDealId, input.dealId),
        eq(deals.isChangeOrder, true),
        eq(deals.isActive, true)
      )
    )
    .returning(childChangeOrderColumns)) as ChildCoRow[];
  if (child) {
    // Record the child CO's description change (source "change_order"), sharing the update's timestamp.
    if (input.description !== undefined && input.updatedBy) {
      await recordDescriptionHistoryChange(tenantDb, {
        dealId: child.id,
        oldDescription: previousChildDescription,
        newDescription: child.description,
        changedBy: input.updatedBy,
        source: "change_order",
        // changedAt omitted -> DB now() at insert (post-lock), so concurrent CO edits order correctly.
      });
    }
    // A change order earns commission, so commission must track the CURRENT CO value. When the amount or
    // signed date changes, recompute the child's commission (in-place, attribution-preserving + all-or-
    // nothing) so the payout reflects the edit — never a stale amount, never a duplicate row, and never a
    // delete that loses the row if it can't be recomputed. child.signedDate is the child's won_closed_date,
    // which we keep equal to contract_signed_date, so it is the correct signing date.
    // Resilient: a commission-config gap must not block the edit (mirrors addDealChangeOrder).
    if ((input.amount !== undefined || input.signedDate !== undefined) && input.updatedBy && child.signedDate) {
      try {
        await recalculateCommissionForDeal(tenantDb, {
          dealId: child.id,
          contractSignedDate: String(child.signedDate),
          triggeredByUserId: input.updatedBy,
        });
      } catch (err) {
        console.error(`[ChangeOrders] commission recompute failed for CO child ${child.id}:`, err);
      }
    }
    return childRowToChangeOrderRecord(child);
  }

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
  return legacyRowToChangeOrderRecord(legacy as Record<string, unknown>);
}

export async function deleteDealChangeOrder(
  tenantDb: TenantDb,
  input: { id: string; dealId: string; deletedBy?: string | null }
): Promise<ChangeOrderRecord> {
  // Deleting a CO child SOFT-deletes its deal row, never a hard row delete: a CO child is a real deal that
  // accrues dependent rows referencing deals(id) without ON DELETE CASCADE (the stage_history backstop
  // today; tasks/notes/photos under full-deal treatment), so a hard delete would FK-violate. Soft-delete is
  // FK-immune + audit-preserving, and removes the CO from the counted-once CO reads above (is_active filter).
  //
  // We set TWO markers on delete:
  //   - is_active=false : the canonical "deleted" marker (drives the CO list/sum/getById exclusion + search).
  //   - on_hold=true    : a TOMBSTONE. Not all Won rollups filter is_active (e.g. getClosedWonSummary uses
  //     the on_hold-only reportable predicate), so a voided CO would otherwise keep inflating Won count +
  //     value. They DO all exclude on_hold (reportable predicate) and zero on_hold value
  //     (aliasedEffectiveWonDealValueSql), so on_hold=true reuses that to drop the voided CO from every Won
  //     rollup with no predicate change. It is invisible to on-hold surfaces (they require is_active=true).
  //     (The full normal-deal is_active fix in the reportable predicate is the separate report-accuracy PR.)
  // Try the child first, then fall back to an un-migrated legacy row (value-only — safe to hard-delete).
  const [child] = (await tenantDb
    .update(deals)
    .set({ isActive: false, onHold: true, updatedAt: new Date() })
    .where(
      and(
        eq(deals.id, input.id),
        eq(deals.parentDealId, input.dealId),
        eq(deals.isChangeOrder, true),
        eq(deals.isActive, true)
      )
    )
    .returning(childChangeOrderColumns)) as ChildCoRow[];
  if (child) {
    // A voided CO must not leave an earned commission behind: some earned-commission report queries join
    // deals without an is_active filter, so a soft-deleted CO's commission would otherwise linger in payout
    // totals. Resilient: a commission-cleanup failure must not block the delete.
    try {
      await removeCommissionForDeal(tenantDb, child.id, input.deletedBy ?? null);
    } catch (err) {
      console.error(`[ChangeOrders] commission removal failed for soft-deleted CO child ${child.id}:`, err);
    }
    // Dismiss the child's open tasks (getTasks doesn't filter inactive deals, so they'd otherwise linger in
    // queues for a deleted CO). The parent-delete cascade already dismisses child tasks; do the same here.
    await tenantDb
      .update(tasks)
      .set({ status: "dismissed", isOverdue: false })
      .where(and(eq(tasks.dealId, child.id), inArray(tasks.status, ["pending", "in_progress"])));
    return childRowToChangeOrderRecord(child);
  }

  const [legacy] = await tenantDb
    .delete(dealChangeOrders)
    .where(and(eq(dealChangeOrders.id, input.id), eq(dealChangeOrders.dealId, input.dealId)))
    .returning();
  if (!legacy) {
    throw new AppError(404, "Change order not found");
  }
  return legacyRowToChangeOrderRecord(legacy as Record<string, unknown>);
}

/**
 * Soft-delete every active change-order CHILD of a parent deal (is_active=false), returning their ids.
 * Called by deleteDeal when a parent is soft-deleted: the DB self-FK ON DELETE CASCADE only fires on a
 * hard row delete, so without this a parent's soft-delete would leave its CO children as orphaned active
 * Won deals (their value lingering in Won reports). Returns the affected child ids so the caller can also
 * dismiss their open tasks, mirroring the parent's own cleanup.
 */
export async function softDeleteChangeOrderChildren(
  tenantDb: TenantDb,
  parentDealId: string,
  deletedBy?: string | null
): Promise<string[]> {
  const rows = (await tenantDb
    // is_active=false = canonical delete marker; on_hold=true = tombstone so the on_hold-only Won rollups
    // (which don't all filter is_active) also drop the voided child — same mechanism as deleteDealChangeOrder.
    .update(deals)
    .set({ isActive: false, onHold: true, updatedAt: new Date() })
    .where(
      and(
        eq(deals.parentDealId, parentDealId),
        eq(deals.isChangeOrder, true),
        eq(deals.isActive, true)
      )
    )
    .returning({ id: deals.id })) as Array<{ id: string }>;
  const ids = rows.map((r) => r.id);
  // A voided CO must not leave an earned commission behind (see deleteDealChangeOrder). Resilient per child.
  for (const id of ids) {
    try {
      await removeCommissionForDeal(tenantDb, id, deletedBy ?? null);
    } catch (err) {
      console.error(`[ChangeOrders] commission removal failed for cascade-voided CO child ${id}:`, err);
    }
  }
  return ids;
}
