import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import type {
  InterventionPolicyRecommendationConfidence,
  InterventionPolicyRecommendationDecisionStatus,
  InterventionPolicyRecommendationEvaluationSummary,
  InterventionPolicyRecommendationReviewDecisionFilter,
  InterventionPolicyRecommendationReviewModel,
  InterventionPolicyRecommendationReviewRow,
  InterventionPolicyRecommendationReviewWindow,
  InterventionPolicyRecommendationTaxonomy,
} from "./intervention-types.js";
import { getInterventionPolicyRecommendationEvaluationSummary } from "./intervention-policy-application-service.js";

type TenantDb = NodePgDatabase<typeof schema>;

type InMemoryTenantDb = {
  state: {
    policyRecommendationSnapshots?: Array<Record<string, any>>;
    policyRecommendationDecisions?: Array<Record<string, any>>;
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
  const snapshot = await fetchLatestRenderablePolicySnapshot(tenantDb, input.officeId);
  const summary: InterventionPolicyRecommendationEvaluationSummary = await getInterventionPolicyRecommendationEvaluationSummary(tenantDb, {
    officeId: input.officeId,
    window: input.window ?? "last_30_days",
    decision: input.decision === "all" ? null : input.decision ?? null,
  });

  if (!snapshot) {
    return {
      snapshot: null,
      summary,
      emptyStateScope: "latest_snapshot",
      emptyStateReason: null,
      latestDecisionRows: [],
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
  };
}
