import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import type {
  InterventionPolicyRecommendationConfidence,
  InterventionPolicyRecommendationThresholdCalibrationNoProposalReason,
  InterventionPolicyRecommendationDecisionStatus,
  InterventionPolicyRecommendationEvaluationSummary,
  InterventionPolicyRecommendationHistoryEntry,
  InterventionPolicyRecommendationQualificationBlocker,
  InterventionPolicyRecommendationQualificationTuningAction,
  InterventionPolicyRecommendationTuningGuidanceEntry,
  InterventionPolicyRecommendationReviewDecisionFilter,
  InterventionPolicyRecommendationReviewModel,
  InterventionPolicyRecommendationReviewRow,
  InterventionPolicyRecommendationReviewWindow,
  InterventionPolicyRecommendationTaxonomy,
  InterventionPolicyRecommendationYieldNextAction,
} from "./intervention-types.js";
import { getInterventionPolicyRecommendationEvaluationSummary } from "./intervention-policy-application-service.js";
import { getInterventionPolicyRecommendationSeedValidationStatus } from "./intervention-policy-recommendation-seed-service.js";
import {
  POLICY_RECOMMENDATION_PRIMARY_CAP,
  POLICY_RECOMMENDATION_QUALIFICATION_FLOOR,
  POLICY_RECOMMENDATION_SECONDARY_CAP,
  POLICY_RECOMMENDATION_STRONG_FLOOR,
} from "./intervention-service.js";

type TenantDb = NodePgDatabase<typeof schema>;

type InMemoryTenantDb = {
  state: {
    policyRecommendationSnapshots?: Array<Record<string, any>>;
    policyRecommendationRows?: Array<Record<string, any>>;
    policyRecommendationDecisions?: Array<Record<string, any>>;
    policyRecommendationApplyEvents?: Array<Record<string, any>>;
    users?: Array<Record<string, any>>;
  };
};

type PolicySnapshotRow = {
  id: string;
  office_id: string;
  status: "active" | "degraded";
  generated_at: Date | string;
  stale_at: Date | string;
  superseded_at: Date | string | null;
};

type PolicyDecisionRow = {
  taxonomy: InterventionPolicyRecommendationTaxonomy;
  grouping_key: string;
  decision: InterventionPolicyRecommendationDecisionStatus;
  suppression_reason: string | null;
  score: number | null;
  confidence: InterventionPolicyRecommendationConfidence | null;
  used_fallback_copy: boolean;
  used_fallback_structured_payload: boolean;
  created_at?: Date | string | null;
};

type PolicyRecommendationRow = {
  recommendation_id: string;
  snapshot_id: string;
  office_id: string;
  taxonomy: InterventionPolicyRecommendationTaxonomy;
  title: string;
  generated_at: Date | string;
};

type PolicyApplyEventRow = {
  office_id?: string;
  recommendation_id: string;
  snapshot_id: string;
  taxonomy: InterventionPolicyRecommendationTaxonomy;
  actor_user_id: string;
  actor_display_name?: string | null;
  status: string;
  rejection_reason: string | null;
  created_at: Date | string;
  title?: string | null;
};

const THRESHOLD_CALIBRATION_METADATA: Record<
  InterventionPolicyRecommendationTaxonomy,
  {
    currentThreshold: string;
    proposedThreshold: string | null;
    expectedYieldEffect: string;
    guardrails: string[];
  }
> = {
  snooze_policy_adjustment: {
    currentThreshold: "minimum breached cases >= 4",
    proposedThreshold: "minimum breached cases >= 3",
    expectedYieldEffect: "May allow a small number of snooze-policy recommendations to render without broadening the taxonomy aggressively.",
    guardrails: [
      "Do not materially increase low-confidence snooze-policy output.",
      "Do not let cap pressure replace threshold pressure as the dominant blocker after calibration.",
    ],
  },
  escalation_policy_adjustment: {
    currentThreshold: "minimum adverse escalations >= 5",
    proposedThreshold: "minimum adverse escalations >= 4",
    expectedYieldEffect: "May surface a narrow set of escalation-policy recommendations that are currently just below the floor.",
    guardrails: [
      "Do not convert low-volume escalation noise into live recommendations.",
      "Do not increase monitor-only output as a side effect of the follow-up calibration.",
    ],
  },
  assignee_load_balancing: {
    currentThreshold: "minimum concentrated risky cases >= 6",
    proposedThreshold: "minimum concentrated risky cases >= 5",
    expectedYieldEffect: "May allow assignee-balancing proposals to appear earlier when overload signals are already concentrated.",
    guardrails: [
      "Do not surface balancing recommendations that are driven by one-off load spikes.",
      "Do not reduce the floor if target coverage becomes the dominant blocker instead.",
    ],
  },
  disconnect_playbook_change: {
    currentThreshold: "minimum adverse disconnect cluster volume >= 5",
    proposedThreshold: "minimum adverse disconnect cluster volume >= 4",
    expectedYieldEffect: "May surface playbook changes for disconnect clusters that are currently suppressed by a narrow volume gap.",
    guardrails: [
      "Do not let predicate-limited clusters become threshold-driven proposals artificially.",
      "Do not increase low-confidence playbook churn after the follow-up calibration.",
    ],
  },
  monitor_only: {
    currentThreshold: "minimum monitor signal count >= 6",
    proposedThreshold: null,
    expectedYieldEffect: "Monitor-only recommendations should stay advisory and not be threshold-calibrated in this slice.",
    guardrails: [
      "Do not calibrate monitor-only output through this proposal block.",
    ],
  },
};

const MINIMUM_CALIBRATION_VOLUME = 3;

function isInMemoryTenantDb(value: unknown): value is InMemoryTenantDb {
  return Boolean(value && typeof value === "object" && "state" in value);
}

function toIso(value: Date | string | null | undefined) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function sortDecisionRows(left: PolicyDecisionRow, right: PolicyDecisionRow) {
  const decisionRank = (value: InterventionPolicyRecommendationDecisionStatus) =>
    value === "qualified_rendered" ? 0 : 1;
  const leftRank = decisionRank(left.decision);
  const rightRank = decisionRank(right.decision);
  if (leftRank !== rightRank) return leftRank - rightRank;
  if ((right.score ?? -Infinity) !== (left.score ?? -Infinity)) {
    return (right.score ?? -Infinity) - (left.score ?? -Infinity);
  }
  return new Date(toIso(right.created_at) ?? 0).getTime() - new Date(toIso(left.created_at) ?? 0).getTime();
}

function buildEmptyStateReason(rows: PolicyDecisionRow[]) {
  if (rows.some((row) => row.decision === "qualified_rendered")) return null;

  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = row.suppression_reason ?? row.decision;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const dominant = [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? null;
  if (!dominant) return null;

  if (dominant === "predicate_not_met" || dominant === "suppressed_by_predicate") {
    return "In the latest snapshot, candidates were mostly suppressed because the qualification predicates were not met.";
  }
  if (dominant === "suppressed_by_threshold") {
    return "In the latest snapshot, candidates were mostly suppressed because they did not clear the qualification threshold.";
  }
  if (dominant === "suppressed_by_missing_target") {
    return "In the latest snapshot, candidates were mostly suppressed because a policy target was missing.";
  }
  if (dominant === "suppressed_by_apply_ineligible") {
    return "In the latest snapshot, candidates were mostly suppressed because they were not apply-eligible.";
  }
  if (dominant === "qualified_suppressed_by_cap") {
    return "In the latest snapshot, candidates qualified but were outranked by higher-priority recommendations.";
  }

  return `In the latest snapshot, candidates were mostly suppressed because of ${dominant.replaceAll("_", " ")}.`;
}

async function fetchLatestRenderablePolicySnapshot(tenantDb: TenantDb | InMemoryTenantDb, officeId: string) {
  if (isInMemoryTenantDb(tenantDb)) {
    const rows = (tenantDb.state.policyRecommendationSnapshots ?? []) as PolicySnapshotRow[];
    return (
      rows
        .filter((row) => row.office_id === officeId && (row.status === "active" || row.status === "degraded"))
        .sort((left, right) => new Date(toIso(right.generated_at) ?? 0).getTime() - new Date(toIso(left.generated_at) ?? 0).getTime())[0] ?? null
    );
  }

  const result = await tenantDb.execute(sql`
    SELECT id, office_id, status, generated_at, stale_at, superseded_at
    FROM ai_policy_recommendation_snapshots
    WHERE office_id = ${officeId}
      AND status IN ('active', 'degraded')
    ORDER BY generated_at DESC
    LIMIT 1
  `);
  return (((result as any).rows ?? [])[0] ?? null) as PolicySnapshotRow | null;
}

async function fetchSnapshotDecisionRows(
  tenantDb: TenantDb | InMemoryTenantDb,
  officeId: string,
  snapshotId: string,
  decision: InterventionPolicyRecommendationReviewDecisionFilter
) {
  const filterRow = (row: PolicyDecisionRow) => {
    if (decision === "all") return true;
    if (decision === "rendered") return row.decision === "qualified_rendered";
    return row.decision !== "qualified_rendered";
  };

  if (isInMemoryTenantDb(tenantDb)) {
    return ((tenantDb.state.policyRecommendationDecisions ?? []) as PolicyDecisionRow[])
      .filter((row: any) => row.office_id === officeId && row.snapshot_id === snapshotId)
      .filter(filterRow)
      .sort(sortDecisionRows)
      .slice(0, 10);
  }

  const result = await tenantDb.execute(sql`
    SELECT taxonomy, grouping_key, decision, suppression_reason, score, confidence, used_fallback_copy, used_fallback_structured_payload, created_at
    FROM ai_policy_recommendation_decisions
    WHERE office_id = ${officeId}
      AND snapshot_id = ${snapshotId}
    ORDER BY created_at DESC
  `);
  return (((result as any).rows ?? []) as PolicyDecisionRow[])
    .filter(filterRow)
    .sort(sortDecisionRows)
    .slice(0, 10);
}

function mapReviewRows(rows: PolicyDecisionRow[]): InterventionPolicyRecommendationReviewRow[] {
  return rows.map((row) => ({
    taxonomy: row.taxonomy,
    groupingKey: row.grouping_key,
    decision: row.decision,
    suppressionReason: row.suppression_reason,
    score: row.score,
    confidence: row.confidence,
    usedFallbackCopy: row.used_fallback_copy,
    usedFallbackStructuredPayload: row.used_fallback_structured_payload,
    createdAt: toIso(row.created_at),
  }));
}

function buildTuningGuidance(
  summary: InterventionPolicyRecommendationEvaluationSummary
): InterventionPolicyRecommendationReviewModel["tuning"] {
  const guidance: InterventionPolicyRecommendationTuningGuidanceEntry[] = summary.byTaxonomy.map((row) => {
    if (row.counts.qualifiedRendered === 0 && row.counts.suppressedByThreshold > 0) {
      return {
        taxonomy: row.taxonomy,
        recommendedAction: "lower_qualification_floor",
        summary: "This taxonomy is clearing predicates but failing the qualification floor too often.",
      };
    }
    if (row.counts.qualifiedRendered === 0 && row.counts.suppressedByPredicate > 0) {
      return {
        taxonomy: row.taxonomy,
        recommendedAction: "seed_more_history",
        summary: "This taxonomy is mostly blocked by predicates, which usually means the office needs more qualifying history.",
      };
    }
    if (row.counts.qualifiedSuppressedByCap > 0) {
      return {
        taxonomy: row.taxonomy,
        recommendedAction: "review_ranking_cap",
        summary: "This taxonomy is qualifying but being crowded out by the render cap.",
      };
    }
    return {
      taxonomy: row.taxonomy,
      recommendedAction: "hold_thresholds",
      summary: "This taxonomy is behaving within the current qualification floor and cap settings.",
    };
  });

  return {
    currentThresholds: {
      qualificationFloor: POLICY_RECOMMENDATION_QUALIFICATION_FLOOR,
      strongRecommendationFloor: POLICY_RECOMMENDATION_STRONG_FLOOR,
      primaryCap: POLICY_RECOMMENDATION_PRIMARY_CAP,
      secondaryCap: POLICY_RECOMMENDATION_SECONDARY_CAP,
    },
    guidance,
  };
}

function getReviewWindowCutoff(window: InterventionPolicyRecommendationReviewWindow, now = new Date()) {
  const windowMs =
    window === "last_7_days"
      ? 7 * 24 * 60 * 60 * 1000
      : window === "last_90_days"
        ? 90 * 24 * 60 * 60 * 1000
        : 30 * 24 * 60 * 60 * 1000;
  return now.getTime() - windowMs;
}

async function fetchWindowDecisionRows(
  tenantDb: TenantDb | InMemoryTenantDb,
  officeId: string,
  window: InterventionPolicyRecommendationReviewWindow,
  now = new Date()
) {
  const cutoff = getReviewWindowCutoff(window, now);

  if (isInMemoryTenantDb(tenantDb)) {
    return ((tenantDb.state.policyRecommendationDecisions ?? []) as Array<Record<string, any>>)
      .filter((row) => row.office_id === officeId)
      .filter((row) => new Date(toIso(row.created_at) ?? 0).getTime() >= cutoff) as PolicyDecisionRow[];
  }

  const result = await tenantDb.execute(sql`
    SELECT taxonomy, grouping_key, decision, suppression_reason, score, confidence, used_fallback_copy, used_fallback_structured_payload, created_at
    FROM ai_policy_recommendation_decisions
    WHERE office_id = ${officeId}
      AND created_at >= ${new Date(cutoff)}
  `);
  return (((result as any).rows ?? []) as PolicyDecisionRow[]);
}

async function fetchGlobalWindowDecisionRows(
  tenantDb: TenantDb | InMemoryTenantDb,
  window: InterventionPolicyRecommendationReviewWindow,
  now = new Date()
) {
  const cutoff = getReviewWindowCutoff(window, now);

  if (isInMemoryTenantDb(tenantDb)) {
    return ((tenantDb.state.policyRecommendationDecisions ?? []) as Array<Record<string, any>>).filter(
      (row) => new Date(toIso(row.created_at) ?? 0).getTime() >= cutoff
    ) as PolicyDecisionRow[];
  }

  const result = await tenantDb.execute(sql`
    SELECT taxonomy, grouping_key, decision, suppression_reason, score, confidence, used_fallback_copy, used_fallback_structured_payload, created_at
    FROM ai_policy_recommendation_decisions
    WHERE created_at >= ${new Date(cutoff)}
  `);
  return (((result as any).rows ?? []) as PolicyDecisionRow[]);
}

function buildYieldSummary(
  summary: InterventionPolicyRecommendationEvaluationSummary,
  windowDecisionRows: PolicyDecisionRow[]
): InterventionPolicyRecommendationReviewModel["yield"] {
  const renderedByTaxonomy = summary.byTaxonomy.map((row) => ({
    taxonomy: row.taxonomy,
    renderedCount: row.counts.qualifiedRendered,
  }));

  const suppressionReasonCounts = new Map<string, number>();
  for (const row of windowDecisionRows) {
    if (row.decision === "qualified_rendered") continue;
    const reason = row.suppression_reason ?? row.decision;
    suppressionReasonCounts.set(reason, (suppressionReasonCounts.get(reason) ?? 0) + 1);
  }

  const dominantSuppressionReasons = [...suppressionReasonCounts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 3)
    .map(([reason, count]) => ({ reason, count }));

  const dominantSuppressionReason = dominantSuppressionReasons[0]?.reason ?? null;
  const recommendedNextAction: InterventionPolicyRecommendationYieldNextAction =
    dominantSuppressionReason === "predicate_not_met" || dominantSuppressionReason === "suppressed_by_predicate"
      ? "seed_or_wait_for_more_history"
      : dominantSuppressionReason === "threshold_not_met" || dominantSuppressionReason === "suppressed_by_threshold"
        ? "review_threshold_floor"
        : dominantSuppressionReason === "qualified_suppressed_by_cap"
          ? "review_ranking_cap"
          : dominantSuppressionReason === "suppressed_by_missing_target" ||
              dominantSuppressionReason === "suppressed_by_apply_ineligible"
            ? "review_target_coverage"
            : "hold_thresholds";

  return {
    renderedTotals: {
      window: summary.window,
      total: summary.totals.qualifiedRendered,
    },
    renderedByTaxonomy,
    dominantSuppressionReasons,
    recommendedNextAction,
  };
}

function mapSuppressionToDiagnosticBlocker(
  decision: InterventionPolicyRecommendationDecisionStatus,
  suppressionReason: string | null
): InterventionPolicyRecommendationQualificationBlocker {
  const reason = suppressionReason ?? decision;
  if (reason === "suppressed_by_apply_ineligible") {
    return "eligibility_limited";
  }
  if (reason === "suppressed_by_missing_target" || reason === "missing_policy_target") {
    return "target_limited";
  }
  if (reason === "qualified_suppressed_by_cap") {
    return "cap_limited";
  }
  if (reason === "suppressed_by_threshold" || reason === "threshold_not_met") {
    return "threshold_limited";
  }
  if (reason === "suppressed_by_predicate" || reason === "predicate_not_met") {
    return "history_limited";
  }
  return "healthy_low_volume";
}

function mapBlockerToRecommendedAction(
  blocker: InterventionPolicyRecommendationQualificationBlocker
): InterventionPolicyRecommendationQualificationTuningAction {
  if (blocker === "history_limited") return "seed_non_prod_validation";
  if (blocker === "threshold_limited") return "review_threshold_floor_in_code";
  if (blocker === "cap_limited") return "review_ranking_cap_in_code";
  if (blocker === "target_limited") return "review_target_coverage";
  if (blocker === "eligibility_limited") return "review_apply_eligibility";
  return "hold_current_thresholds";
}

function diagnosticBlockerSortValue(blocker: InterventionPolicyRecommendationQualificationBlocker) {
  switch (blocker) {
    case "target_limited":
      return 0;
    case "eligibility_limited":
      return 1;
    case "threshold_limited":
      return 2;
    case "cap_limited":
      return 3;
    case "history_limited":
      return 4;
    default:
      return 4;
  }
}

function buildQualificationDiagnostics(
  summary: InterventionPolicyRecommendationEvaluationSummary,
  windowDecisionRows: PolicyDecisionRow[]
): InterventionPolicyRecommendationReviewModel["diagnostics"] {
  const taxonomyDiagnostics = summary.byTaxonomy.map((row) => {
    const suppressedCounts = {
      predicateBlocked: row.counts.suppressedByPredicate,
      thresholdBlocked: row.counts.suppressedByThreshold,
      capBlocked: row.counts.qualifiedSuppressedByCap,
      missingTarget: row.counts.suppressedByMissingTarget,
      applyIneligible: row.counts.suppressedByApplyIneligible,
    };

    const blockerCounts: Array<{
      blocker: InterventionPolicyRecommendationQualificationBlocker;
      count: number;
    }> = [
      { blocker: "threshold_limited", count: suppressedCounts.thresholdBlocked },
      { blocker: "history_limited", count: suppressedCounts.predicateBlocked },
      { blocker: "cap_limited", count: suppressedCounts.capBlocked },
      { blocker: "target_limited", count: suppressedCounts.missingTarget },
      { blocker: "eligibility_limited", count: suppressedCounts.applyIneligible },
    ];
    const dominant = blockerCounts
      .filter((entry) => entry.count > 0)
      .sort((left, right) => right.count - left.count || diagnosticBlockerSortValue(left.blocker) - diagnosticBlockerSortValue(right.blocker))[0];
    const dominantBlocker = dominant?.blocker ?? "healthy_low_volume";

    const topSuppressedCandidates = windowDecisionRows
      .filter((candidate) => candidate.taxonomy === row.taxonomy && candidate.decision !== "qualified_rendered")
      .sort((left, right) => {
        const blockerDiff =
          diagnosticBlockerSortValue(mapSuppressionToDiagnosticBlocker(left.decision, left.suppression_reason)) -
          diagnosticBlockerSortValue(mapSuppressionToDiagnosticBlocker(right.decision, right.suppression_reason));
        if (blockerDiff !== 0) return blockerDiff;
        if ((right.score ?? -Infinity) !== (left.score ?? -Infinity)) {
          return (right.score ?? -Infinity) - (left.score ?? -Infinity);
        }
        const createdAtDiff =
          new Date(toIso(right.created_at) ?? 0).getTime() - new Date(toIso(left.created_at) ?? 0).getTime();
        if (createdAtDiff !== 0) return createdAtDiff;
        return left.grouping_key.localeCompare(right.grouping_key);
      })
      .slice(0, 5)
      .map((candidate) => ({
        groupingKey: candidate.grouping_key,
        decision: candidate.decision,
        suppressionReason: candidate.suppression_reason,
        score: candidate.score,
        confidence: candidate.confidence,
        createdAt: toIso(candidate.created_at),
      }));

    return {
      scope: "historical_window" as const,
      taxonomy: row.taxonomy,
      renderedCount: row.counts.qualifiedRendered,
      suppressedCounts,
      dominantBlocker,
      topSuppressedCandidates,
      recommendedTuningAction: mapBlockerToRecommendedAction(dominantBlocker),
    };
  });

  const systemBlockerCounts = new Map<InterventionPolicyRecommendationQualificationBlocker, number>();
  for (const row of windowDecisionRows) {
    if (row.decision === "qualified_rendered") continue;
    const blocker = mapSuppressionToDiagnosticBlocker(row.decision, row.suppression_reason);
    systemBlockerCounts.set(blocker, (systemBlockerCounts.get(blocker) ?? 0) + 1);
  }

  const dominantBlockers = [...systemBlockerCounts.entries()]
    .sort((left, right) => right[1] - left[1] || diagnosticBlockerSortValue(left[0]) - diagnosticBlockerSortValue(right[0]))
    .map(([blocker, count]) => ({ blocker, count }));

  return {
    window: summary.window,
    generatedAt: summary.generatedAt,
    systemDiagnostics: {
      scope: "historical_window",
      dominantBlockers,
      recommendedNextAction: mapBlockerToRecommendedAction(dominantBlockers[0]?.blocker ?? "healthy_low_volume"),
    },
    taxonomyDiagnostics,
    seededValidationStatus: getInterventionPolicyRecommendationSeedValidationStatus(),
  };
}

function buildThresholdCalibrationSelectionSummary(count: number) {
  if (count === 0) return "No threshold-limited taxonomies qualify for calibration proposals right now.";
  if (count === 1) return "1 taxonomy is currently the best candidate for a global threshold review.";
  return `${count} taxonomies are currently the best candidates for a global threshold review.`;
}

function buildThresholdCalibrationNoProposalReason(
  taxonomySummaries: Array<{
    taxonomy: InterventionPolicyRecommendationTaxonomy;
    renderedCount: number;
    predicateBlocked: number;
    thresholdBlocked: number;
    capBlocked: number;
    targetBlocked: number;
  }>
): InterventionPolicyRecommendationThresholdCalibrationNoProposalReason {
  const lowVolumeThresholdCandidates = taxonomySummaries.filter((row) => {
    const metadata = THRESHOLD_CALIBRATION_METADATA[row.taxonomy];
    if (!metadata?.proposedThreshold) return false;
    const candidateVolume = row.renderedCount + row.thresholdBlocked;
    return (
      row.thresholdBlocked > 0 &&
      row.thresholdBlocked > row.predicateBlocked &&
      row.thresholdBlocked > row.capBlocked &&
      row.thresholdBlocked > row.targetBlocked &&
      candidateVolume < MINIMUM_CALIBRATION_VOLUME
    );
  });
  if (lowVolumeThresholdCandidates.length > 0) {
    return "low_volume_dominates";
  }

  const totals = taxonomySummaries.reduce(
    (acc, row) => {
      acc.predicate += row.predicateBlocked;
      acc.cap += row.capBlocked;
      acc.target += row.targetBlocked;
      acc.threshold += row.thresholdBlocked;
      return acc;
    },
    { predicate: 0, cap: 0, target: 0, threshold: 0 }
  );
  const entries: Array<[InterventionPolicyRecommendationThresholdCalibrationNoProposalReason, number]> = [
    ["predicate_failure_dominates", totals.predicate],
    ["cap_pressure_dominates", totals.cap],
    ["target_coverage_dominates", totals.target],
    ["threshold_pressure_not_dominant", totals.threshold],
  ];
  const [dominantReason, dominantCount] = entries.sort((left, right) => right[1] - left[1])[0] ?? [
    "low_volume_dominates",
    0,
  ];
  if (dominantCount <= 0) return "low_volume_dominates";
  return dominantReason;
}

function buildThresholdCalibrationProposals(
  window: InterventionPolicyRecommendationReviewWindow,
  generatedAt: string,
  decisionRows: PolicyDecisionRow[]
): InterventionPolicyRecommendationReviewModel["thresholdCalibrationProposals"] {
  const taxonomies = Object.keys(THRESHOLD_CALIBRATION_METADATA) as InterventionPolicyRecommendationTaxonomy[];
  const taxonomySummaries = taxonomies.map((taxonomy) => {
    const rows = decisionRows.filter((row) => row.taxonomy === taxonomy);
    return {
      taxonomy,
      renderedCount: rows.filter((row) => row.decision === "qualified_rendered").length,
      predicateBlocked: rows.filter((row) => row.decision === "suppressed_by_predicate").length,
      thresholdBlocked: rows.filter((row) => row.decision === "suppressed_by_threshold").length,
      capBlocked: rows.filter((row) => row.decision === "qualified_suppressed_by_cap").length,
      targetBlocked: rows.filter(
        (row) => row.decision === "suppressed_by_missing_target" || row.decision === "suppressed_by_apply_ineligible"
      ).length,
    };
  });

  const proposals = taxonomySummaries
    .map((row) => {
      const metadata = THRESHOLD_CALIBRATION_METADATA[row.taxonomy];
      if (!metadata?.proposedThreshold) return null;

      const predicateBlocked = row.predicateBlocked;
      const thresholdBlocked = row.thresholdBlocked;
      const capBlocked = row.capBlocked;
      const targetBlocked = row.targetBlocked;
      const candidateVolume = row.renderedCount + thresholdBlocked;

      if (thresholdBlocked <= 0) return null;
      if (candidateVolume < MINIMUM_CALIBRATION_VOLUME) return null;
      if (thresholdBlocked <= predicateBlocked) return null;
      if (thresholdBlocked <= capBlocked) return null;
      if (thresholdBlocked <= targetBlocked) return null;

      const blockerBreakdown = [
        { label: "threshold blocked", count: thresholdBlocked },
        { label: "predicate blocked", count: predicateBlocked },
        { label: "cap blocked", count: capBlocked },
        { label: "target blocked", count: targetBlocked },
        { label: "rendered", count: row.renderedCount },
      ].filter((entry) => entry.count > 0);

      return {
        taxonomy: row.taxonomy,
        currentThreshold: metadata.currentThreshold,
        proposedThreshold: metadata.proposedThreshold,
        dominantBlocker: "threshold_limited" as const,
        blockerBreakdown,
        rationale:
          "Threshold failures dominate while predicate clearance and existing rendered volume suggest a bounded global floor reduction is the next defensible calibration move.",
        expectedYieldEffect: metadata.expectedYieldEffect,
        guardrails: metadata.guardrails,
        verificationChecklist: [
          "Record current rendered count for this taxonomy before any threshold change.",
          "Re-check threshold-blocked count after the follow-up calibration deploy.",
          "Confirm this taxonomy does not become the dominant low-confidence source.",
        ],
        rankingScore: thresholdBlocked * 100 + candidateVolume * 10 + row.renderedCount,
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    .sort((left, right) => right.rankingScore - left.rankingScore || left.taxonomy.localeCompare(right.taxonomy))
    .slice(0, 2)
    .map(({ rankingScore: _rankingScore, ...entry }) => entry);

  return {
    generatedAt,
    window,
    selectionSummary: buildThresholdCalibrationSelectionSummary(proposals.length),
    noProposalReason: proposals.length ? null : buildThresholdCalibrationNoProposalReason(taxonomySummaries),
    proposals,
  };
}

function historySummaryForEvent(row: { eventType: string; title: string; rejectionReason: string | null }) {
  if (row.eventType === "rendered") return `Rendered recommendation "${row.title}".`;
  if (row.eventType === "applied") return `Applied recommendation "${row.title}".`;
  if (row.eventType === "applied_noop") {
    return `Applied recommendation "${row.title}" as a no-op because the target policy already matched.`;
  }
  if (row.eventType === "reverted") return `Undid recommendation "${row.title}".`;
  if (row.eventType === "revert_noop") return `Undo for recommendation "${row.title}" was a no-op.`;
  if (row.eventType === "revert_rejected_conflict") {
    return row.rejectionReason ?? `Undo for recommendation "${row.title}" was rejected because the policy changed.`;
  }
  if (row.eventType === "rejected_validation") {
    return row.rejectionReason ?? `Rejected recommendation "${row.title}" during validation.`;
  }
  if (row.eventType === "rejected_stale") {
    return row.rejectionReason ?? `Rejected stale recommendation "${row.title}".`;
  }
  if (row.eventType === "rejected_conflict") {
    return row.rejectionReason ?? `Rejected recommendation "${row.title}" because of a policy conflict.`;
  }
  return `Recorded ${row.eventType.replaceAll("_", " ")} for "${row.title}".`;
}

async function fetchActorDisplayName(
  tenantDb: TenantDb | InMemoryTenantDb,
  actorUserId: string
) {
  if (isInMemoryTenantDb(tenantDb)) {
    return (
      ((tenantDb.state.users ?? []) as Array<Record<string, any>>).find((row) => row.id === actorUserId)?.displayName ??
      actorUserId
    );
  }

  const result = await tenantDb.execute(sql`
    SELECT display_name
    FROM public.users
    WHERE id = ${actorUserId}
    LIMIT 1
  `);
  return (((result as any).rows ?? [])[0]?.display_name ?? actorUserId) as string;
}

async function fetchRecentHistory(
  tenantDb: TenantDb | InMemoryTenantDb,
  officeId: string,
  window: InterventionPolicyRecommendationReviewWindow,
  now = new Date()
): Promise<InterventionPolicyRecommendationHistoryEntry[]> {
  const cutoff = getReviewWindowCutoff(window, now);

  const renderedRows = isInMemoryTenantDb(tenantDb)
    ? (((tenantDb.state.policyRecommendationRows ?? []) as PolicyRecommendationRow[]).filter(
        (row) => row.office_id === officeId
      ) as PolicyRecommendationRow[])
    : ((((
        await tenantDb.execute(sql`
          SELECT recommendation_id, snapshot_id, office_id, taxonomy, title, generated_at
          FROM ai_policy_recommendation_rows
          WHERE office_id = ${officeId}
        `)
      ) as any).rows ?? []) as PolicyRecommendationRow[]);

  const applyRows = isInMemoryTenantDb(tenantDb)
    ? (((tenantDb.state.policyRecommendationApplyEvents ?? []) as PolicyApplyEventRow[]).filter(
        (row: any) => row.office_id === officeId
      ) as PolicyApplyEventRow[])
    : ((((
        await tenantDb.execute(sql`
          SELECT
            a.recommendation_id,
            a.snapshot_id,
            a.taxonomy,
            a.actor_user_id,
            u.display_name AS actor_display_name,
            a.status,
            a.rejection_reason,
            a.created_at,
            r.title
          FROM ai_policy_recommendation_apply_events a
          LEFT JOIN public.users u ON u.id = a.actor_user_id
          LEFT JOIN ai_policy_recommendation_rows r
            ON r.office_id = a.office_id
           AND r.snapshot_id = a.snapshot_id
           AND r.recommendation_id = a.recommendation_id
          WHERE a.office_id = ${officeId}
        `)
      ) as any).rows ?? []) as PolicyApplyEventRow[]);

  const titleByRecommendation = new Map(
    renderedRows.map((row) => [`${row.recommendation_id}:${row.snapshot_id}`, row.title] as const)
  );

  const renderedEntries = renderedRows
    .filter((row) => new Date(toIso(row.generated_at) ?? 0).getTime() >= cutoff)
    .map(
      (row): InterventionPolicyRecommendationHistoryEntry => ({
        recommendationId: row.recommendation_id,
        snapshotId: row.snapshot_id,
        taxonomy: row.taxonomy,
        title: row.title,
        eventType: "rendered",
        actorName: null,
        summary: historySummaryForEvent({
          eventType: "rendered",
          title: row.title,
          rejectionReason: null,
        }),
        occurredAt: toIso(row.generated_at) ?? new Date().toISOString(),
      })
    );

  const applyEntries = await Promise.all(
    applyRows
      .filter((row) => new Date(toIso(row.created_at) ?? 0).getTime() >= cutoff)
      .map(async (row): Promise<InterventionPolicyRecommendationHistoryEntry> => {
        const actorName =
          row.actor_display_name ?? (await fetchActorDisplayName(tenantDb, row.actor_user_id));
        const title =
          row.title ??
          titleByRecommendation.get(`${row.recommendation_id}:${row.snapshot_id}`) ??
          row.recommendation_id;
        return {
          recommendationId: row.recommendation_id,
          snapshotId: row.snapshot_id,
          taxonomy: row.taxonomy,
          title,
          eventType: row.status as InterventionPolicyRecommendationHistoryEntry["eventType"],
          actorName,
          summary: historySummaryForEvent({
            eventType: row.status,
            title,
            rejectionReason: row.rejection_reason,
          }),
          occurredAt: toIso(row.created_at) ?? new Date().toISOString(),
        };
      })
  );

  const newestLifecycleByRecommendation = new Map<string, number>();
  for (const entry of applyEntries) {
    const key = `${entry.recommendationId}:${entry.snapshotId}`;
    const occurredAtMs = new Date(entry.occurredAt).getTime();
    newestLifecycleByRecommendation.set(
      key,
      Math.max(newestLifecycleByRecommendation.get(key) ?? -Infinity, occurredAtMs)
    );
  }

  return [...applyEntries, ...renderedEntries.filter((entry) => {
    const key = `${entry.recommendationId}:${entry.snapshotId}`;
    const newestLifecycleMs = newestLifecycleByRecommendation.get(key);
    if (newestLifecycleMs == null) return true;
    return new Date(entry.occurredAt).getTime() > newestLifecycleMs;
  })]
    .sort((left, right) => new Date(right.occurredAt).getTime() - new Date(left.occurredAt).getTime())
    .slice(0, 20);
}

export async function getInterventionPolicyRecommendationReview(
  tenantDb: TenantDb | InMemoryTenantDb,
  input: {
    officeId: string;
    viewerUserId: string;
    window?: InterventionPolicyRecommendationReviewWindow;
    decision?: InterventionPolicyRecommendationReviewDecisionFilter;
    now?: Date;
  }
): Promise<InterventionPolicyRecommendationReviewModel> {
  const window = input.window ?? "last_30_days";
  const snapshot = await fetchLatestRenderablePolicySnapshot(tenantDb, input.officeId);
  const [, summary] = await Promise.all([
    getInterventionPolicyRecommendationEvaluationSummary(tenantDb, {
      officeId: input.officeId,
      window,
      decision: input.decision === "all" ? null : input.decision ?? null,
      now: input.now,
    }),
    getInterventionPolicyRecommendationEvaluationSummary(tenantDb, {
      officeId: input.officeId,
      window,
      decision: null,
      now: input.now,
    }),
  ]);
  const reviewNow = input.now ?? new Date();
  const [windowDecisionRows, globalWindowDecisionRows] = await Promise.all([
    fetchWindowDecisionRows(tenantDb, input.officeId, window, reviewNow),
    fetchGlobalWindowDecisionRows(tenantDb, window, reviewNow),
  ]);
  const recentHistory = await fetchRecentHistory(tenantDb, input.officeId, window, reviewNow);

  if (!snapshot) {
    return {
      snapshot: null,
      summary,
      emptyStateScope: "latest_snapshot",
      emptyStateReason: null,
      latestDecisionRows: [],
      recentHistory,
      diagnostics: buildQualificationDiagnostics(summary, windowDecisionRows),
      yield: buildYieldSummary(summary, windowDecisionRows),
      tuning: buildTuningGuidance(summary),
      thresholdCalibrationProposals: buildThresholdCalibrationProposals(window, summary.generatedAt, globalWindowDecisionRows),
    };
  }

  const allSnapshotRows = await fetchSnapshotDecisionRows(tenantDb, input.officeId, snapshot.id, "all");
  const rawRows =
    input.decision && input.decision !== "all"
      ? await fetchSnapshotDecisionRows(tenantDb, input.officeId, snapshot.id, input.decision)
      : allSnapshotRows;

  return {
    snapshot: {
      id: snapshot.id,
      officeId: snapshot.office_id,
      status: snapshot.status,
      generatedAt: toIso(snapshot.generated_at) ?? new Date().toISOString(),
      staleAt: toIso(snapshot.stale_at) ?? new Date().toISOString(),
      supersededAt: toIso(snapshot.superseded_at),
    },
    summary,
    emptyStateScope: "latest_snapshot",
    emptyStateReason: buildEmptyStateReason(allSnapshotRows),
    latestDecisionRows: mapReviewRows(rawRows),
    recentHistory,
    diagnostics: buildQualificationDiagnostics(summary, windowDecisionRows),
    yield: buildYieldSummary(summary, windowDecisionRows),
    tuning: buildTuningGuidance(summary),
    thresholdCalibrationProposals: buildThresholdCalibrationProposals(window, summary.generatedAt, globalWindowDecisionRows),
  };
}
