import { getDealAtRiskResult, type AtRiskResult, type UserRole, type WorkflowRoute } from "@trock-crm/shared/types";

export type AiAtRiskDealRow = {
  stage_slug?: string | null;
  workflow_route?: string | null;
  stage_entered_at?: string | Date | null;
  expected_close_date?: string | Date | null;
  /** The estimating auto-park horizon (2026-07-27) — see AtRiskDealInput.bidDueDate. */
  bid_due_date?: string | Date | null;
  on_hold?: boolean | null;
  on_hold_started_at?: string | Date | null;
  on_hold_accumulated_seconds?: string | number | bigint | null;
  on_hold_accumulated_seconds_at_stage_entry?: string | number | bigint | null;
};

function normalizeWorkflowRoute(value: string | null | undefined): WorkflowRoute {
  return value === "service" ? "service" : "normal";
}

function numberOrNull(value: string | number | bigint | null | undefined): number | null {
  if (value == null) return null;
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : null;
}

export function getAiDealAtRiskResult(
  row: AiAtRiskDealRow,
  viewerRole: UserRole = "rep",
  now: Date = new Date()
): AtRiskResult {
  return getDealAtRiskResult(
    {
      stageSlug: row.stage_slug,
      workflowRoute: normalizeWorkflowRoute(row.workflow_route),
      stageEnteredAt: row.stage_entered_at,
      expectedCloseDate: row.expected_close_date ?? null,
      // Estimating rows auto-park off the BID due date (2026-07-27), so the copilot's at-risk signals
      // never nag about a deal the board already shows as parked and worth $0.
      bidDueDate: row.bid_due_date ?? null,
      // Honor a postponement (near today-or-future close target) so the copilot's disconnect/blind-spot
      // at-risk signals match the deal-detail "Postponed" state, not just the 90+ day auto-hold.
      applyCloseTargetSuppression: true,
      onHold: row.on_hold,
      onHoldStartedAt: row.on_hold_started_at,
      onHoldAccumulatedSeconds: numberOrNull(row.on_hold_accumulated_seconds),
      onHoldAccumulatedSecondsAtStageEntry: numberOrNull(
        row.on_hold_accumulated_seconds_at_stage_entry
      ),
    },
    viewerRole,
    now
  );
}
