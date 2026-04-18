import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";

type TenantDb = NodePgDatabase<typeof schema>;

type ForecastMilestoneKey = "initial" | "qualified" | "estimating" | "closed_won";
type CaptureSource = "live" | "audit_backfill";

interface ForecastSnapshot {
  assignedRepId: string | null;
  workflowRoute: string | null;
  stageId: string | null;
  expectedCloseDate: string | null;
  ddEstimate: string | null;
  bidEstimate: string | null;
  awardedAmount: string | null;
  source: string | null;
}

interface ForecastMilestoneInsert extends ForecastSnapshot {
  dealId: string;
  milestoneKey: ForecastMilestoneKey;
  capturedBy: string | null;
  capturedAt?: string | Date;
  captureSource: CaptureSource;
  forecastAmount: string;
}

interface StageDrivenCaptureInput {
  deal: {
    id: string;
    assignedRepId: string;
    workflowRoute: string | null;
    ddEstimate: string | null;
    bidEstimate: string | null;
    awardedAmount: string | null;
    stageId: string | null;
    expectedCloseDate: string | null;
    source: string | null;
  };
  currentStage: { slug: string | null };
  targetStage: { slug: string | null };
  userId: string;
}

interface ForecastBackfillInput {
  dealId: string;
  source: string | null;
  workflowRoute: string | null;
  stageId: string | null;
  assignedRepId?: string | null;
  auditInsertRow?: {
    created_at?: string | Date | null;
    full_row?: {
      workflow_route?: string | null;
      stage_id?: string | null;
      dd_estimate?: string | null;
      bid_estimate?: string | null;
      awarded_amount?: string | null;
      expected_close_date?: string | null;
      source?: string | null;
    } | null;
  } | null;
  closedWonDealRow?: {
    stageId?: string | null;
    workflowRoute?: string | null;
    ddEstimate?: string | null;
    bidEstimate?: string | null;
    awardedAmount?: string | null;
    expectedCloseDate?: string | null;
    source?: string | null;
    actualCloseDate?: string | Date | null;
  } | null;
}

function normalizeNumericString(value?: string | number | null): string | null {
  if (value === null || value === undefined) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric.toFixed(2) : null;
}

export function deriveForecastAmount(values: {
  awardedAmount?: string | number | null;
  bidEstimate?: string | number | null;
  ddEstimate?: string | number | null;
}): number {
  const awarded = Number(values.awardedAmount ?? NaN);
  if (Number.isFinite(awarded)) return awarded;

  const bid = Number(values.bidEstimate ?? NaN);
  if (Number.isFinite(bid)) return bid;

  const dd = Number(values.ddEstimate ?? NaN);
  if (Number.isFinite(dd)) return dd;

  return 0;
}

function toForecastInsert(
  values: Omit<ForecastMilestoneInsert, "forecastAmount"> & {
    forecastAmount?: string | number | null;
  }
): ForecastMilestoneInsert {
  const numericForecast =
    values.forecastAmount !== undefined && values.forecastAmount !== null
      ? Number(values.forecastAmount)
      : deriveForecastAmount(values);

  return {
    ...values,
    workflowRoute: values.workflowRoute ?? "estimating",
    forecastAmount: Number.isFinite(numericForecast) ? String(numericForecast) : "0",
    ddEstimate: normalizeNumericString(values.ddEstimate),
    bidEstimate: normalizeNumericString(values.bidEstimate),
    awardedAmount: normalizeNumericString(values.awardedAmount),
    expectedCloseDate: values.expectedCloseDate ?? null,
    stageId: values.stageId ?? null,
    source: values.source ?? null,
  };
}

export async function insertForecastMilestone(
  tenantDb: TenantDb,
  values: ForecastMilestoneInsert,
  options?: { replaceExisting?: boolean }
): Promise<void> {
  if (options?.replaceExisting) {
    await tenantDb.execute(sql`
      INSERT INTO deal_forecast_milestones (
        deal_id,
        milestone_key,
        captured_at,
        captured_by,
        assigned_rep_id,
        stage_id,
        workflow_route,
        expected_close_date,
        dd_estimate,
        bid_estimate,
        awarded_amount,
        forecast_amount,
        source,
        capture_source
      )
      VALUES (
        ${values.dealId}::uuid,
        ${values.milestoneKey},
        COALESCE(${values.capturedAt ?? null}::timestamptz, NOW()),
        ${values.capturedBy}::uuid,
        ${values.assignedRepId}::uuid,
        ${values.stageId}::uuid,
        ${values.workflowRoute},
        ${values.expectedCloseDate}::date,
        ${values.ddEstimate}::numeric,
        ${values.bidEstimate}::numeric,
        ${values.awardedAmount}::numeric,
        ${values.forecastAmount}::numeric,
        ${values.source},
        ${values.captureSource}
      )
      ON CONFLICT (deal_id, milestone_key) DO UPDATE
      SET
        captured_at = EXCLUDED.captured_at,
        captured_by = EXCLUDED.captured_by,
        assigned_rep_id = EXCLUDED.assigned_rep_id,
        stage_id = EXCLUDED.stage_id,
        workflow_route = EXCLUDED.workflow_route,
        expected_close_date = EXCLUDED.expected_close_date,
        dd_estimate = EXCLUDED.dd_estimate,
        bid_estimate = EXCLUDED.bid_estimate,
        awarded_amount = EXCLUDED.awarded_amount,
        forecast_amount = EXCLUDED.forecast_amount,
        source = EXCLUDED.source,
        capture_source = EXCLUDED.capture_source
    `);
    return;
  }

  await tenantDb.execute(sql`
    INSERT INTO deal_forecast_milestones (
      deal_id,
      milestone_key,
      captured_at,
      captured_by,
      assigned_rep_id,
      stage_id,
      workflow_route,
      expected_close_date,
      dd_estimate,
      bid_estimate,
      awarded_amount,
      forecast_amount,
      source,
      capture_source
    )
    VALUES (
      ${values.dealId}::uuid,
      ${values.milestoneKey},
      COALESCE(${values.capturedAt ?? null}::timestamptz, NOW()),
      ${values.capturedBy}::uuid,
      ${values.assignedRepId}::uuid,
      ${values.stageId}::uuid,
      ${values.workflowRoute},
      ${values.expectedCloseDate}::date,
      ${values.ddEstimate}::numeric,
      ${values.bidEstimate}::numeric,
      ${values.awardedAmount}::numeric,
      ${values.forecastAmount}::numeric,
      ${values.source},
      ${values.captureSource}
    )
    ON CONFLICT (deal_id, milestone_key) DO NOTHING
  `);
}

export async function captureInitialForecastMilestone(
  tenantDb: TenantDb,
  input: {
    deal: {
      id: string;
      assignedRepId: string;
      workflowRoute: string | null;
      stageId: string | null;
      expectedCloseDate: string | null;
      ddEstimate: string | null;
      bidEstimate: string | null;
      awardedAmount: string | null;
      source: string | null;
    };
    userId: string;
  }
): Promise<void> {
  await insertForecastMilestone(
    tenantDb,
    toForecastInsert({
      dealId: input.deal.id,
      milestoneKey: "initial",
      capturedBy: input.userId,
      assignedRepId: input.deal.assignedRepId,
      stageId: input.deal.stageId,
      workflowRoute: input.deal.workflowRoute,
      expectedCloseDate: input.deal.expectedCloseDate,
      ddEstimate: input.deal.ddEstimate,
      bidEstimate: input.deal.bidEstimate,
      awardedAmount: input.deal.awardedAmount,
      source: input.deal.source,
      captureSource: "live",
    })
  );
}

function milestoneKeyForTransition(
  currentStageSlug?: string | null,
  targetStageSlug?: string | null
): ForecastMilestoneKey | null {
  if (!targetStageSlug || currentStageSlug === targetStageSlug) {
    return null;
  }

  if (targetStageSlug === "dd") return "qualified";
  if (targetStageSlug === "estimating") return "estimating";
  if (targetStageSlug === "closed_won") return "closed_won";
  return null;
}

export async function captureStageDrivenForecastMilestone(
  tenantDb: TenantDb,
  input: StageDrivenCaptureInput
): Promise<void> {
  const milestoneKey = milestoneKeyForTransition(input.currentStage.slug, input.targetStage.slug);
  if (!milestoneKey) {
    return;
  }

  await tenantDb.execute(sql`
    SELECT 1
    FROM deal_forecast_milestones dfm
    WHERE dfm.deal_id = ${input.deal.id}::uuid
      AND dfm.milestone_key = ${milestoneKey}
    LIMIT 1
  `);

  await insertForecastMilestone(
    tenantDb,
    toForecastInsert({
      dealId: input.deal.id,
      milestoneKey,
      capturedBy: input.userId,
      assignedRepId: input.deal.assignedRepId,
      stageId: input.deal.stageId,
      workflowRoute: input.deal.workflowRoute,
      expectedCloseDate: input.deal.expectedCloseDate,
      ddEstimate: input.deal.ddEstimate,
      bidEstimate: input.deal.bidEstimate,
      awardedAmount: input.deal.awardedAmount,
      source: input.deal.source,
      captureSource: "live",
    }),
    { replaceExisting: milestoneKey === "closed_won" }
  );
}

export function buildForecastMilestoneBackfillRows(
  input: ForecastBackfillInput
): ForecastMilestoneInsert[] {
  const rows: ForecastMilestoneInsert[] = [];
  const auditFullRow = input.auditInsertRow?.full_row ?? null;

  if (auditFullRow) {
    rows.push(
      toForecastInsert({
        dealId: input.dealId,
        milestoneKey: "initial",
        capturedBy: null,
        assignedRepId: input.assignedRepId ?? null,
        capturedAt: input.auditInsertRow?.created_at ?? undefined,
        stageId: auditFullRow.stage_id ?? input.stageId ?? null,
        workflowRoute: auditFullRow.workflow_route ?? input.workflowRoute ?? "estimating",
        expectedCloseDate: auditFullRow.expected_close_date ?? null,
        ddEstimate: auditFullRow.dd_estimate ?? null,
        bidEstimate: auditFullRow.bid_estimate ?? null,
        awardedAmount: auditFullRow.awarded_amount ?? null,
        source: auditFullRow.source ?? input.source ?? null,
        captureSource: "audit_backfill",
      })
    );
  }

  if (input.closedWonDealRow?.actualCloseDate) {
    rows.push(
      toForecastInsert({
        dealId: input.dealId,
        milestoneKey: "closed_won",
        capturedBy: null,
        assignedRepId: input.assignedRepId ?? null,
        capturedAt: input.closedWonDealRow.actualCloseDate ?? undefined,
        stageId: input.closedWonDealRow.stageId ?? input.stageId ?? null,
        workflowRoute: input.closedWonDealRow.workflowRoute ?? input.workflowRoute ?? "estimating",
        expectedCloseDate: input.closedWonDealRow.expectedCloseDate ?? null,
        ddEstimate: input.closedWonDealRow.ddEstimate ?? null,
        bidEstimate: input.closedWonDealRow.bidEstimate ?? null,
        awardedAmount: input.closedWonDealRow.awardedAmount ?? null,
        source: input.closedWonDealRow.source ?? input.source ?? null,
        captureSource: "audit_backfill",
      })
    );
  }

  return rows;
}
