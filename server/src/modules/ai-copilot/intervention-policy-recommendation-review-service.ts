import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import type {
  InterventionPolicyRecommendationConfidence,
  InterventionPolicyRecommendationDecisionStatus,
  InterventionPolicyRecommendationEvaluationSummary,
  InterventionPolicyRecommendationHistoryEntry,
  InterventionPolicyRecommendationTuningGuidanceEntry,
  InterventionPolicyRecommendationReviewDecisionFilter,
  InterventionPolicyRecommendationReviewModel,
  InterventionPolicyRecommendationReviewRow,
  InterventionPolicyRecommendationReviewWindow,
  InterventionPolicyRecommendationTaxonomy,
} from "./intervention-types.js";
import { getInterventionPolicyRecommendationEvaluationSummary } from "./intervention-policy-application-service.js";
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

function getReviewWindowCutoff(window: InterventionPolicyRecommendationReviewWindow) {
  const windowMs =
    window === "last_7_days"
      ? 7 * 24 * 60 * 60 * 1000
      : window === "last_90_days"
        ? 90 * 24 * 60 * 60 * 1000
        : 30 * 24 * 60 * 60 * 1000;
  return Date.now() - windowMs;
}

function historySummaryForEvent(row: { eventType: string; title: string; rejectionReason: string | null }) {
  if (row.eventType === "rendered") return `Rendered recommendation "${row.title}".`;
  if (row.eventType === "applied") return `Applied recommendation "${row.title}".`;
  if (row.eventType === "applied_noop") {
    return `Applied recommendation "${row.title}" as a no-op because the target policy already matched.`;
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
  window: InterventionPolicyRecommendationReviewWindow
): Promise<InterventionPolicyRecommendationHistoryEntry[]> {
  const cutoff = getReviewWindowCutoff(window);

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
    renderedRows.map((row) => [row.recommendation_id, row.title] as const)
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
        const title = row.title ?? titleByRecommendation.get(row.recommendation_id) ?? row.recommendation_id;
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

  return [...applyEntries, ...renderedEntries]
    .sort((left, right) => new Date(right.occurredAt).getTime() - new Date(left.occurredAt).getTime())
    .slice(0, 12);
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
  const summary: InterventionPolicyRecommendationEvaluationSummary = await getInterventionPolicyRecommendationEvaluationSummary(tenantDb, {
    officeId: input.officeId,
    window,
    decision: input.decision === "all" ? null : input.decision ?? null,
  });
  const recentHistory = await fetchRecentHistory(tenantDb, input.officeId, window);

  if (!snapshot) {
    return {
      snapshot: null,
      summary,
      emptyStateScope: "latest_snapshot",
      emptyStateReason: null,
      latestDecisionRows: [],
      recentHistory,
      tuning: buildTuningGuidance(summary),
    };
  }

  const rawRows = await fetchSnapshotDecisionRows(tenantDb, input.officeId, snapshot.id, input.decision ?? "all");

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
    emptyStateReason: buildEmptyStateReason(rawRows),
    latestDecisionRows: mapReviewRows(rawRows),
    recentHistory,
    tuning: buildTuningGuidance(summary),
  };
}
