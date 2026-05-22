import type { UserRole } from "./enums.js";
import { getEffectiveStageAgeSeconds } from "./deal-hold.js";
import {
  getSlaAudienceForRole,
  getSlaPolicyForRole,
  type ResolvedSlaPolicy,
  type SlaPolicyStageSlug,
} from "./sla-policy.js";
import {
  CANONICAL_TERMINAL_DEAL_STAGE_SLUGS,
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
  | "missing_policy";

export interface AtRiskInput {
  /** Canonical or legacy deal stage slug. Legacy aliases require workflowRoute unless unambiguous. */
  stageSlug: string | null | undefined;
  workflowRoute?: WorkflowRoute | null;
  /** Hold-aware age for the current stage. Callers should derive this with getEffectiveStageAgeSeconds. */
  effectiveStageAgeSeconds: number | null | undefined;
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
  return getAtRiskResult({
    stageSlug: deal.stageSlug,
    workflowRoute: deal.workflowRoute,
    viewerRole,
    effectiveStageAgeSeconds: getEffectiveStageAgeSeconds(deal, now),
  });
}
