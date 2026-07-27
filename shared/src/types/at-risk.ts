import type { UserRole } from "./enums.js";
import { getEffectiveStageAgeSeconds } from "./deal-hold.js";
import { isAtRiskSuppressedByCloseTarget, isDealEffectivelyOnHold } from "./deal-hold-risk.js";
import {
  getSlaAudienceForRole,
  getSlaPolicyForRole,
  type ResolvedSlaPolicy,
  type SlaPolicyStageSlug,
} from "./sla-policy.js";
import {
  CANONICAL_TERMINAL_DEAL_STAGE_SLUGS,
  ESTIMATING_STAGE_SLUG,
  isCanonicalDealStageSlug,
  toCanonicalDealStageSlug,
  type CanonicalDealStageSlug,
  type WorkflowRoute,
} from "./workflow.js";

const SECONDS_PER_DAY = 24 * 60 * 60;

export type AtRiskStatus = "not_applicable" | "not_at_risk" | "at_risk";
export type AtRiskSeverity = "none" | "at_risk";
export type AtRiskReason =
  | "within_sla"
  | "threshold_reached"
  | "unknown_stage"
  | "terminal_stage"
  | "unsupported_role"
  | "missing_policy"
  | "on_hold"
  | "close_target_pending";

export interface AtRiskInput {
  /** Canonical or legacy deal stage slug. Legacy aliases require workflowRoute unless unambiguous. */
  stageSlug: string | null | undefined;
  workflowRoute?: WorkflowRoute | null;
  /** Hold-aware age for the current stage. Callers should derive this with getEffectiveStageAgeSeconds. */
  effectiveStageAgeSeconds: number | null | undefined;
  /** Current hold flag. Active hold clears risk; historical hold time is reflected only in effective age. */
  onHold?: boolean | null;
  /**
   * Set when a future close target (expected_close_date within the auto-hold window) should quiet the
   * stage-age at-risk verdict. Computed by callers that have `now` — see {@link getDealAtRiskResult}.
   */
  closeTargetSuppressesRisk?: boolean;
  viewerRole: UserRole | null | undefined;
}

export interface AtRiskDealInput {
  stageSlug: string | null | undefined;
  workflowRoute?: WorkflowRoute | null;
  stageEnteredAt?: string | Date | null;
  onHold?: boolean | null;
  onHoldStartedAt?: string | Date | null;
  onHoldAccumulatedSeconds?: number | null;
  onHoldAccumulatedSecondsAtStageEntry?: number | null;
  /** The deal's close target (= expected_close_date); drives close-target suppression / auto-on-hold. */
  expectedCloseDate?: string | Date | null;
  /**
   * The deal's BID due date (`deals.bid_due_date`). Used ONLY for the 90+ day auto-on-hold exclusion, and
   * ONLY while the deal is in the genuine 'estimating' stage, where it replaces the close target as the
   * auto-park horizon (2026-07-27). It deliberately does NOT feed the shorter close-target SLA
   * suppression, which stays keyed on expected_close_date in every stage. A caller that forgets to select
   * it does not error — the row silently keeps the old close-target rule, so every at-risk row source
   * must forward it.
   */
  bidDueDate?: string | Date | null;
  /**
   * Whether a today-or-future close target inside the auto-hold window should suppress risk.
   * Defaults to true for deal-detail style SLA messaging. Callers that only want the 90+ day
   * effective-hold exclusion should pass false while still forwarding expectedCloseDate.
   */
  applyCloseTargetSuppression?: boolean;
}

/**
 * Shared At Risk contract for later API and UI slices.
 *
 * `isAtRisk` is the primary boolean. The remaining fields describe why the
 * decision was made and the exact policy/age values needed for labels,
 * badges, tooltips, and API responses.
 */
export interface AtRiskResult {
  isAtRisk: boolean;
  status: AtRiskStatus;
  severity: AtRiskSeverity;
  reason: AtRiskReason;
  stageSlug: string | null;
  canonicalStageSlug: CanonicalDealStageSlug | null;
  viewerRole: UserRole | null;
  audience: ResolvedSlaPolicy["audience"] | null;
  policy: ResolvedSlaPolicy | null;
  effectiveStageAgeSeconds: number;
  effectiveStageAgeDays: number;
  thresholdSeconds: number | null;
  thresholdDays: number | null;
  secondsUntilThreshold: number | null;
  secondsPastThreshold: number | null;
}

function normalizeEffectiveAgeSeconds(value: number | null | undefined): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value ?? 0));
}

function buildNotApplicableResult(
  input: AtRiskInput,
  reason: Exclude<AtRiskReason, "within_sla" | "threshold_reached">,
  canonicalStageSlug: CanonicalDealStageSlug | null,
  effectiveStageAgeSeconds: number
): AtRiskResult {
  const viewerRole = input.viewerRole ?? null;

  return {
    isAtRisk: false,
    status: "not_applicable",
    severity: "none",
    reason,
    stageSlug: input.stageSlug ?? null,
    canonicalStageSlug,
    viewerRole,
    audience: getSlaAudienceForRole(viewerRole),
    policy: null,
    effectiveStageAgeSeconds,
    effectiveStageAgeDays: Math.floor(effectiveStageAgeSeconds / SECONDS_PER_DAY),
    thresholdSeconds: null,
    thresholdDays: null,
    secondsUntilThreshold: null,
    secondsPastThreshold: null,
  };
}

function resolveCanonicalDealStageSlug(
  stageSlug: string | null | undefined,
  workflowRoute?: WorkflowRoute | null
): CanonicalDealStageSlug | null {
  if (!stageSlug) return null;

  const routedStageSlug = toCanonicalDealStageSlug(stageSlug, workflowRoute);
  if (routedStageSlug && isCanonicalDealStageSlug(routedStageSlug)) return routedStageSlug;
  if (workflowRoute) return null;

  const normalStageSlug = toCanonicalDealStageSlug(stageSlug, "normal");
  const serviceStageSlug = toCanonicalDealStageSlug(stageSlug, "service");
  return normalStageSlug &&
    normalStageSlug === serviceStageSlug &&
    isCanonicalDealStageSlug(normalStageSlug)
    ? normalStageSlug
    : null;
}

function isTerminalCanonicalDealStage(stageSlug: CanonicalDealStageSlug): boolean {
  return (CANONICAL_TERMINAL_DEAL_STAGE_SLUGS as readonly string[]).includes(stageSlug);
}

/**
 * A not-at-risk result that still carries the policy + stage-age detail, used when risk is cleared by
 * an active hold (`on_hold`) or shielded by a pending close target (`close_target_pending`). Labels
 * and tooltips can therefore still show "Nd / Md SLA" even though the badge does not fire.
 */
function buildSuppressedResult(
  input: AtRiskInput,
  reason: Extract<AtRiskReason, "on_hold" | "close_target_pending">,
  canonicalStageSlug: CanonicalDealStageSlug,
  audience: ResolvedSlaPolicy["audience"],
  policy: ResolvedSlaPolicy,
  effectiveStageAgeSeconds: number,
  thresholdSeconds: number
): AtRiskResult {
  return {
    isAtRisk: false,
    status: "not_at_risk",
    severity: "none",
    reason,
    stageSlug: input.stageSlug ?? null,
    canonicalStageSlug,
    viewerRole: input.viewerRole ?? null,
    audience,
    policy,
    effectiveStageAgeSeconds,
    effectiveStageAgeDays: Math.floor(effectiveStageAgeSeconds / SECONDS_PER_DAY),
    thresholdSeconds,
    thresholdDays: policy.thresholdDays,
    secondsUntilThreshold: Math.max(0, thresholdSeconds - effectiveStageAgeSeconds),
    secondsPastThreshold: Math.max(0, effectiveStageAgeSeconds - thresholdSeconds),
  };
}

export function getAtRiskResult(input: AtRiskInput): AtRiskResult {
  const effectiveStageAgeSeconds = normalizeEffectiveAgeSeconds(input.effectiveStageAgeSeconds);
  const canonicalStageSlug = resolveCanonicalDealStageSlug(input.stageSlug, input.workflowRoute);

  if (!input.stageSlug || !canonicalStageSlug) {
    return buildNotApplicableResult(input, "unknown_stage", null, effectiveStageAgeSeconds);
  }

  if (isTerminalCanonicalDealStage(canonicalStageSlug)) {
    return buildNotApplicableResult(
      input,
      "terminal_stage",
      canonicalStageSlug,
      effectiveStageAgeSeconds
    );
  }

  const audience = getSlaAudienceForRole(input.viewerRole);
  if (!audience) {
    return buildNotApplicableResult(
      input,
      "unsupported_role",
      canonicalStageSlug,
      effectiveStageAgeSeconds
    );
  }

  const policy = getSlaPolicyForRole(canonicalStageSlug as SlaPolicyStageSlug, input.viewerRole);
  if (!policy) {
    return buildNotApplicableResult(
      input,
      "missing_policy",
      canonicalStageSlug,
      effectiveStageAgeSeconds
    );
  }

  const thresholdSeconds = policy.thresholdDays * SECONDS_PER_DAY;

  // Risk is cleared by an active hold (stored or derived auto-on-hold), and only then by a pending
  // close target. on_hold wins so a manually held deal keeps reading "On Hold", not "target pending".
  if (input.onHold === true) {
    return buildSuppressedResult(
      input,
      "on_hold",
      canonicalStageSlug,
      audience,
      policy,
      effectiveStageAgeSeconds,
      thresholdSeconds
    );
  }
  if (input.closeTargetSuppressesRisk === true) {
    return buildSuppressedResult(
      input,
      "close_target_pending",
      canonicalStageSlug,
      audience,
      policy,
      effectiveStageAgeSeconds,
      thresholdSeconds
    );
  }

  const isAtRisk = effectiveStageAgeSeconds >= thresholdSeconds;

  return {
    isAtRisk,
    status: isAtRisk ? "at_risk" : "not_at_risk",
    severity: isAtRisk ? "at_risk" : "none",
    reason: isAtRisk ? "threshold_reached" : "within_sla",
    stageSlug: input.stageSlug,
    canonicalStageSlug,
    viewerRole: input.viewerRole ?? null,
    audience,
    policy,
    effectiveStageAgeSeconds,
    effectiveStageAgeDays: Math.floor(effectiveStageAgeSeconds / SECONDS_PER_DAY),
    thresholdSeconds,
    thresholdDays: policy.thresholdDays,
    secondsUntilThreshold: Math.max(0, thresholdSeconds - effectiveStageAgeSeconds),
    secondsPastThreshold: Math.max(0, effectiveStageAgeSeconds - thresholdSeconds),
  };
}

export function getDealAtRiskResult(
  deal: AtRiskDealInput,
  viewerRole: UserRole | null | undefined,
  now: Date
): AtRiskResult {
  const canonicalStageSlug = resolveCanonicalDealStageSlug(deal.stageSlug, deal.workflowRoute);
  const isTerminalStage =
    canonicalStageSlug != null && isTerminalCanonicalDealStage(canonicalStageSlug);
  const effectiveOnHold = isDealEffectivelyOnHold({
    onHold: deal.onHold,
    expectedCloseDate: deal.expectedCloseDate,
    // Estimating deals auto-park off the BID due date (2026-07-27). canonicalStageSlug is already
    // route-canonicalized (estimate_in_progress folds in, service_estimating does not), so it is the same
    // classification the value/hold SQL makes — an estimating deal that reads $0 on the board must also be
    // quiet in at-risk, or the "relevant and quick" list nags about a deal it says is parked.
    bidDueDate: deal.bidDueDate,
    isEstimating: canonicalStageSlug === ESTIMATING_STAGE_SLUG,
    now,
    isTerminal: isTerminalStage,
  });
  const applyCloseTargetSuppression = deal.applyCloseTargetSuppression ?? true;

  return getAtRiskResult({
    stageSlug: deal.stageSlug,
    workflowRoute: deal.workflowRoute,
    viewerRole,
    effectiveStageAgeSeconds: getEffectiveStageAgeSeconds(deal, now),
    // Stored hold and 90+ day close targets both clear risk as "on_hold"; shorter pending
    // close-target SLA pauses stay opt-in by caller.
    onHold: effectiveOnHold,
    closeTargetSuppressesRisk:
      applyCloseTargetSuppression &&
      isAtRiskSuppressedByCloseTarget({
        expectedCloseDate: deal.expectedCloseDate,
        now,
      }),
  });
}
