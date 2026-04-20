import crypto from "crypto";
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import { AppError } from "../../middleware/error-handler.js";
import type {
  InterventionPolicyRecommendation,
  InterventionPolicyRecommendationApplyEventStatus,
  InterventionPolicyRecommendationEvaluationSummary,
  InterventionPolicyRecommendationTaxonomy,
} from "./intervention-types.js";

type TenantDb = NodePgDatabase<typeof schema>;

type InMemoryTenantDb = {
  state: {
    policyRecommendationSnapshots?: Array<Record<string, any>>;
    policyRecommendationRows?: Array<Record<string, any>>;
    policyRecommendationFeedback?: Array<Record<string, any>>;
    policyRecommendationDecisions?: Array<Record<string, any>>;
    policyRecommendationApplyEvents?: Array<Record<string, any>>;
    interventionSnoozePolicies?: Array<Record<string, any>>;
    interventionEscalationPolicies?: Array<Record<string, any>>;
    interventionAssigneeBalancingPolicies?: Array<Record<string, any>>;
    users?: Array<Record<string, any>>;
  };
};

function isInMemoryTenantDb(value: unknown): value is InMemoryTenantDb {
  return Boolean(value && typeof value === "object" && "state" in value);
}

function toIso(value: Date | string | null | undefined) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function coerceJson(value: unknown) {
  if (value && typeof value === "object") return value as Record<string, unknown>;
  return {};
}

async function fetchLatestRenderableSnapshotId(tenantDb: TenantDb | InMemoryTenantDb, officeId: string) {
  if (isInMemoryTenantDb(tenantDb)) {
    const row = ((tenantDb.state.policyRecommendationSnapshots ?? []) as Array<Record<string, any>>)
      .filter((item) => item.office_id === officeId && (item.status === "active" || item.status === "degraded"))
      .sort((left, right) => new Date(toIso(right.generated_at) ?? 0).getTime() - new Date(toIso(left.generated_at) ?? 0).getTime())[0];
    return row?.id ?? null;
  }

  const result = await tenantDb.execute(sql`
    SELECT id
    FROM ai_policy_recommendation_snapshots
    WHERE office_id = ${officeId}
      AND status IN ('active', 'degraded')
    ORDER BY generated_at DESC
    LIMIT 1
  `);
  return ((result as any).rows?.[0]?.id ?? null) as string | null;
}

async function fetchRecommendationRow(
  tenantDb: TenantDb | InMemoryTenantDb,
  officeId: string,
  recommendationId: string,
  snapshotId: string
) {
  if (isInMemoryTenantDb(tenantDb)) {
    return (((tenantDb.state.policyRecommendationRows ?? []) as Array<Record<string, any>>).find(
      (row) =>
        row.office_id === officeId &&
        row.recommendation_id === recommendationId &&
        row.snapshot_id === snapshotId
    ) ?? null) as Record<string, any> | null;
  }

  const result = await tenantDb.execute(sql`
    SELECT *
    FROM ai_policy_recommendation_rows
    WHERE office_id = ${officeId}
      AND recommendation_id = ${recommendationId}
      AND snapshot_id = ${snapshotId}
    LIMIT 1
  `);
  return (((result as any).rows ?? [])[0] ?? null) as Record<string, any> | null;
}

function compareProposedChange(
  left: InterventionPolicyRecommendation["proposedChange"],
  right: InterventionPolicyRecommendation["proposedChange"]
) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

async function fetchApplyEventByIdempotencyKey(
  tenantDb: TenantDb | InMemoryTenantDb,
  officeId: string,
  recommendationId: string,
  idempotencyKey: string
) {
  if (isInMemoryTenantDb(tenantDb)) {
    return (((tenantDb.state.policyRecommendationApplyEvents ?? []) as Array<Record<string, any>>).find(
      (row) =>
        row.office_id === officeId &&
        row.recommendation_id === recommendationId &&
        row.request_idempotency_key === idempotencyKey
    ) ?? null) as Record<string, any> | null;
  }

  const result = await tenantDb.execute(sql`
    SELECT *
    FROM ai_policy_recommendation_apply_events
    WHERE office_id = ${officeId}
      AND recommendation_id = ${recommendationId}
      AND request_idempotency_key = ${idempotencyKey}
    ORDER BY created_at DESC
    LIMIT 1
  `);
  return (((result as any).rows ?? [])[0] ?? null) as Record<string, any> | null;
}

async function fetchActorName(tenantDb: TenantDb | InMemoryTenantDb, actorUserId: string) {
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

async function readCurrentPolicyState(
  tenantDb: TenantDb | InMemoryTenantDb,
  officeId: string,
  recommendation: Record<string, any>
) {
  const proposed = recommendation.proposed_change_json as InterventionPolicyRecommendation["proposedChange"];
  if (!proposed) return null;

  if (proposed.kind === "snooze_policy_adjustment") {
    if (isInMemoryTenantDb(tenantDb)) {
      return (
        ((tenantDb.state.interventionSnoozePolicies ?? []) as Array<Record<string, any>>).find(
          (row) => row.office_id === officeId && row.snooze_reason_key === proposed.targetKey
        ) ?? {
          office_id: officeId,
          snooze_reason_key: proposed.targetKey,
          max_snooze_days: proposed.currentValue.maxSnoozeDays,
          breach_review_threshold_percent: proposed.currentValue.breachReviewThresholdPercent,
        }
      );
    }
    const result = await tenantDb.execute(sql`
      SELECT office_id, snooze_reason_key, max_snooze_days, breach_review_threshold_percent
      FROM intervention_snooze_policies
      WHERE office_id = ${officeId}
        AND snooze_reason_key = ${proposed.targetKey}
      LIMIT 1
    `);
    return (((result as any).rows ?? [])[0] ?? {
      office_id: officeId,
      snooze_reason_key: proposed.targetKey,
      max_snooze_days: proposed.currentValue.maxSnoozeDays,
      breach_review_threshold_percent: proposed.currentValue.breachReviewThresholdPercent,
    }) as Record<string, any>;
  }

  if (proposed.kind === "escalation_policy_adjustment") {
    if (isInMemoryTenantDb(tenantDb)) {
      return (
        ((tenantDb.state.interventionEscalationPolicies ?? []) as Array<Record<string, any>>).find(
          (row) => row.office_id === officeId && row.disconnect_type_key === proposed.targetKey
        ) ?? {
          office_id: officeId,
          disconnect_type_key: proposed.targetKey,
          routing_mode: proposed.currentValue.routingMode,
          escalation_threshold_percent: proposed.currentValue.escalationThresholdPercent,
        }
      );
    }
    const result = await tenantDb.execute(sql`
      SELECT office_id, disconnect_type_key, routing_mode, escalation_threshold_percent
      FROM intervention_escalation_policies
      WHERE office_id = ${officeId}
        AND disconnect_type_key = ${proposed.targetKey}
      LIMIT 1
    `);
    return (((result as any).rows ?? [])[0] ?? {
      office_id: officeId,
      disconnect_type_key: proposed.targetKey,
      routing_mode: proposed.currentValue.routingMode,
      escalation_threshold_percent: proposed.currentValue.escalationThresholdPercent,
    }) as Record<string, any>;
  }

  if (isInMemoryTenantDb(tenantDb)) {
    return (
      ((tenantDb.state.interventionAssigneeBalancingPolicies ?? []) as Array<Record<string, any>>).find(
        (row) => row.office_id === officeId
      ) ?? {
        office_id: officeId,
        balancing_mode: proposed.currentValue.balancingMode,
        overload_share_percent: proposed.currentValue.overloadSharePercent,
        min_high_risk_cases: proposed.currentValue.minHighRiskCases,
      }
    );
  }
  const result = await tenantDb.execute(sql`
    SELECT office_id, balancing_mode, overload_share_percent, min_high_risk_cases
    FROM intervention_assignee_balancing_policies
    WHERE office_id = ${officeId}
    LIMIT 1
  `);
  return (((result as any).rows ?? [])[0] ?? {
    office_id: officeId,
    balancing_mode: proposed.currentValue.balancingMode,
    overload_share_percent: proposed.currentValue.overloadSharePercent,
    min_high_risk_cases: proposed.currentValue.minHighRiskCases,
  }) as Record<string, any>;
}

async function upsertPolicyState(
  tenantDb: TenantDb | InMemoryTenantDb,
  officeId: string,
  recommendation: Record<string, any>
) {
  const proposed = recommendation.proposed_change_json as InterventionPolicyRecommendation["proposedChange"];
  if (!proposed) throw new AppError(400, "Recommendation has no deterministic policy change payload");

  if (proposed.kind === "snooze_policy_adjustment") {
    if (isInMemoryTenantDb(tenantDb)) {
      const rows = (tenantDb.state.interventionSnoozePolicies ??= []);
      const existing = rows.find(
        (row) => row.office_id === officeId && row.snooze_reason_key === proposed.targetKey
      );
      const next = {
        office_id: officeId,
        snooze_reason_key: proposed.targetKey,
        max_snooze_days: proposed.proposedValue.maxSnoozeDays,
        breach_review_threshold_percent: proposed.proposedValue.breachReviewThresholdPercent,
      };
      if (existing) Object.assign(existing, next);
      else rows.push(next);
      return next;
    }
    await tenantDb.execute(sql`
      INSERT INTO intervention_snooze_policies (
        id, office_id, snooze_reason_key, max_snooze_days, breach_review_threshold_percent, created_at, updated_at
      )
      VALUES (
        ${crypto.randomUUID()},
        ${officeId},
        ${proposed.targetKey},
        ${proposed.proposedValue.maxSnoozeDays},
        ${proposed.proposedValue.breachReviewThresholdPercent},
        ${new Date()},
        ${new Date()}
      )
      ON CONFLICT (office_id, snooze_reason_key)
      DO UPDATE SET
        max_snooze_days = EXCLUDED.max_snooze_days,
        breach_review_threshold_percent = EXCLUDED.breach_review_threshold_percent,
        updated_at = EXCLUDED.updated_at
    `);
    return proposed.proposedValue;
  }

  if (proposed.kind === "escalation_policy_adjustment") {
    if (isInMemoryTenantDb(tenantDb)) {
      const rows = (tenantDb.state.interventionEscalationPolicies ??= []);
      const existing = rows.find(
        (row) => row.office_id === officeId && row.disconnect_type_key === proposed.targetKey
      );
      const next = {
        office_id: officeId,
        disconnect_type_key: proposed.targetKey,
        routing_mode: proposed.proposedValue.routingMode,
        escalation_threshold_percent: proposed.proposedValue.escalationThresholdPercent,
      };
      if (existing) Object.assign(existing, next);
      else rows.push(next);
      return next;
    }
    await tenantDb.execute(sql`
      INSERT INTO intervention_escalation_policies (
        id, office_id, disconnect_type_key, routing_mode, escalation_threshold_percent, created_at, updated_at
      )
      VALUES (
        ${crypto.randomUUID()},
        ${officeId},
        ${proposed.targetKey},
        ${proposed.proposedValue.routingMode},
        ${proposed.proposedValue.escalationThresholdPercent},
        ${new Date()},
        ${new Date()}
      )
      ON CONFLICT (office_id, disconnect_type_key)
      DO UPDATE SET
        routing_mode = EXCLUDED.routing_mode,
        escalation_threshold_percent = EXCLUDED.escalation_threshold_percent,
        updated_at = EXCLUDED.updated_at
    `);
    return proposed.proposedValue;
  }

  if (isInMemoryTenantDb(tenantDb)) {
    const rows = (tenantDb.state.interventionAssigneeBalancingPolicies ??= []);
    const existing = rows.find((row) => row.office_id === officeId);
    const next = {
      office_id: officeId,
      balancing_mode: proposed.proposedValue.balancingMode,
      overload_share_percent: proposed.proposedValue.overloadSharePercent,
      min_high_risk_cases: proposed.proposedValue.minHighRiskCases,
    };
    if (existing) Object.assign(existing, next);
    else rows.push(next);
    return next;
  }
  await tenantDb.execute(sql`
    INSERT INTO intervention_assignee_balancing_policies (
      id, office_id, balancing_mode, overload_share_percent, min_high_risk_cases, created_at, updated_at
    )
    VALUES (
      ${crypto.randomUUID()},
      ${officeId},
      ${proposed.proposedValue.balancingMode},
      ${proposed.proposedValue.overloadSharePercent},
      ${proposed.proposedValue.minHighRiskCases},
      ${new Date()},
      ${new Date()}
    )
    ON CONFLICT (office_id)
    DO UPDATE SET
      balancing_mode = EXCLUDED.balancing_mode,
      overload_share_percent = EXCLUDED.overload_share_percent,
      min_high_risk_cases = EXCLUDED.min_high_risk_cases,
      updated_at = EXCLUDED.updated_at
  `);
  return proposed.proposedValue;
}

async function insertApplyEvent(tenantDb: TenantDb | InMemoryTenantDb, row: Record<string, any>) {
  if (isInMemoryTenantDb(tenantDb)) {
    const rows = (tenantDb.state.policyRecommendationApplyEvents ??= []);
    const existing = rows.find(
      (item) =>
        item.office_id === row.office_id &&
        item.recommendation_id === row.recommendation_id &&
        item.request_idempotency_key === row.request_idempotency_key
    );
    if (existing) return existing;
    rows.push(row);
    return row;
  }
  const result = await tenantDb.execute(sql`
    INSERT INTO ai_policy_recommendation_apply_events (
      id, office_id, recommendation_id, snapshot_id, taxonomy, actor_user_id, request_idempotency_key, status,
      target_type, target_id, before_state_json, proposed_state_json, applied_state_json, rejection_reason, created_at
    )
    VALUES (
      ${row.id},
      ${row.office_id},
      ${row.recommendation_id},
      ${row.snapshot_id},
      ${row.taxonomy},
      ${row.actor_user_id},
      ${row.request_idempotency_key},
      ${row.status},
      ${row.target_type},
      ${row.target_id},
      ${JSON.stringify(row.before_state_json)}::jsonb,
      ${JSON.stringify(row.proposed_state_json)}::jsonb,
      ${JSON.stringify(row.applied_state_json)}::jsonb,
      ${row.rejection_reason},
      ${new Date(toIso(row.created_at) ?? new Date().toISOString())}
    )
    ON CONFLICT (office_id, recommendation_id, request_idempotency_key)
    DO UPDATE SET request_idempotency_key = EXCLUDED.request_idempotency_key
    RETURNING *
  `);
  return (((result as any).rows ?? [])[0] ?? row) as Record<string, any>;
}

export async function applyInterventionPolicyRecommendation(
  tenantDb: TenantDb | InMemoryTenantDb,
  input: {
    officeId: string;
    recommendationId: string;
    snapshotId: string;
    actorUserId: string;
    recommendationIdempotencyKey: string;
  }
) {
  const existingEvent = await fetchApplyEventByIdempotencyKey(
    tenantDb,
    input.officeId,
    input.recommendationId,
    input.recommendationIdempotencyKey
  );
  if (existingEvent) {
    return {
      status: existingEvent.status as InterventionPolicyRecommendationApplyEventStatus,
      applyEventId: existingEvent.id,
      recommendationId: input.recommendationId,
      snapshotId: input.snapshotId,
      applyStatus: existingEvent.status,
      appliedAt: toIso(existingEvent.created_at),
      appliedBy: await fetchActorName(tenantDb, existingEvent.actor_user_id),
      reason: existingEvent.rejection_reason ?? null,
      beforeState: coerceJson(existingEvent.before_state_json),
      proposedState: coerceJson(existingEvent.proposed_state_json),
      appliedState: coerceJson(existingEvent.applied_state_json),
    };
  }

  const latestSnapshotId = await fetchLatestRenderableSnapshotId(tenantDb, input.officeId);
  const recommendation = await fetchRecommendationRow(
    tenantDb,
    input.officeId,
    input.recommendationId,
    input.snapshotId
  );

  if (!recommendation) {
    throw new AppError(404, "Policy recommendation not found");
  }

  const proposed = recommendation.proposed_change_json as InterventionPolicyRecommendation["proposedChange"];
  const rejection = (
    status: Exclude<InterventionPolicyRecommendationApplyEventStatus, "applied" | "applied_noop">,
    reason: string
  ) => ({
    id: crypto.randomUUID(),
    office_id: input.officeId,
    recommendation_id: input.recommendationId,
    snapshot_id: input.snapshotId,
    taxonomy: recommendation.taxonomy,
    actor_user_id: input.actorUserId,
    request_idempotency_key: input.recommendationIdempotencyKey,
    status,
    target_type: proposed?.kind ?? "unknown",
    target_id: proposed?.targetKey ?? input.recommendationId,
    before_state_json: {},
    proposed_state_json: proposed?.proposedValue ?? {},
    applied_state_json: {},
    rejection_reason: reason,
    created_at: new Date().toISOString(),
  });

  if (latestSnapshotId !== input.snapshotId) {
    const latestRecommendation =
      latestSnapshotId == null
        ? null
        : await fetchRecommendationRow(tenantDb, input.officeId, input.recommendationId, latestSnapshotId);
    if (!latestRecommendation || !compareProposedChange(latestRecommendation.proposed_change_json ?? null, proposed)) {
    const event = rejection("rejected_stale", "The recommendation snapshot is no longer current.");
    const persisted = await insertApplyEvent(tenantDb, event);
    return {
      status: persisted.status,
      applyEventId: persisted.id,
      recommendationId: input.recommendationId,
      snapshotId: input.snapshotId,
      applyStatus: persisted.status,
      appliedAt: toIso(persisted.created_at),
      appliedBy: await fetchActorName(tenantDb, persisted.actor_user_id),
      reason: persisted.rejection_reason,
      beforeState: {},
      proposedState: coerceJson(persisted.proposed_state_json),
      appliedState: {},
    };
    }
  }

  if (!proposed || recommendation.confidence === "low" || ["disconnect_playbook_change", "monitor_only"].includes(recommendation.taxonomy)) {
    const event = rejection("rejected_validation", "This recommendation is not apply-eligible.");
    const persisted = await insertApplyEvent(tenantDb, event);
    return {
      status: persisted.status,
      applyEventId: persisted.id,
      recommendationId: input.recommendationId,
      snapshotId: input.snapshotId,
      applyStatus: persisted.status,
      appliedAt: toIso(persisted.created_at),
      appliedBy: await fetchActorName(tenantDb, persisted.actor_user_id),
      reason: persisted.rejection_reason,
      beforeState: {},
      proposedState: coerceJson(persisted.proposed_state_json),
      appliedState: {},
    };
  }

  const beforeState = await readCurrentPolicyState(tenantDb, input.officeId, recommendation);
  const appliedState = await upsertPolicyState(tenantDb, input.officeId, recommendation);
  const currentComparable = proposed.kind === "snooze_policy_adjustment"
    ? {
        maxSnoozeDays: beforeState?.max_snooze_days ?? proposed.currentValue.maxSnoozeDays,
        breachReviewThresholdPercent:
          beforeState?.breach_review_threshold_percent ?? proposed.currentValue.breachReviewThresholdPercent,
      }
    : proposed.kind === "escalation_policy_adjustment"
      ? {
          routingMode: beforeState?.routing_mode ?? proposed.currentValue.routingMode,
          escalationThresholdPercent:
            beforeState?.escalation_threshold_percent ?? proposed.currentValue.escalationThresholdPercent,
        }
      : {
          balancingMode: beforeState?.balancing_mode ?? proposed.currentValue.balancingMode,
          overloadSharePercent:
            beforeState?.overload_share_percent ?? proposed.currentValue.overloadSharePercent,
          minHighRiskCases: beforeState?.min_high_risk_cases ?? proposed.currentValue.minHighRiskCases,
        };
  const noop = JSON.stringify(proposed.proposedValue) === JSON.stringify(
    currentComparable
  );

  const event = {
    id: crypto.randomUUID(),
    office_id: input.officeId,
    recommendation_id: input.recommendationId,
    snapshot_id: input.snapshotId,
    taxonomy: recommendation.taxonomy,
    actor_user_id: input.actorUserId,
    request_idempotency_key: input.recommendationIdempotencyKey,
    status: (noop ? "applied_noop" : "applied") as InterventionPolicyRecommendationApplyEventStatus,
    target_type: proposed.kind,
    target_id: proposed.targetKey,
    before_state_json: beforeState ?? {},
    proposed_state_json: proposed.proposedValue,
    applied_state_json: appliedState,
    rejection_reason: null,
    created_at: new Date().toISOString(),
  };
  const persisted = await insertApplyEvent(tenantDb, event);
  return {
    status: persisted.status,
    applyEventId: persisted.id,
    recommendationId: input.recommendationId,
    snapshotId: input.snapshotId,
    applyStatus: persisted.status,
    appliedAt: toIso(persisted.created_at),
    appliedBy: await fetchActorName(tenantDb, persisted.actor_user_id),
    reason: null,
    beforeState: beforeState ?? {},
    proposedState: coerceJson(persisted.proposed_state_json),
    appliedState: appliedState,
  };
}

export async function getInterventionPolicyRecommendationEvaluationSummary(
  tenantDb: TenantDb | InMemoryTenantDb,
  input: {
    officeId: string;
    window?: "last_7_days" | "last_30_days" | "last_90_days";
    taxonomy?: InterventionPolicyRecommendationTaxonomy | null;
    decision?: string | null;
  }
): Promise<InterventionPolicyRecommendationEvaluationSummary> {
  const window = input.window ?? "last_30_days";
  const windowMs =
    window === "last_7_days" ? 7 * 24 * 60 * 60 * 1000 : window === "last_90_days" ? 90 * 24 * 60 * 60 * 1000 : 30 * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - windowMs;
  const rows = isInMemoryTenantDb(tenantDb)
    ? (((tenantDb.state.policyRecommendationDecisions ?? []) as Array<Record<string, any>>).filter(
        (row) => row.office_id === input.officeId
      ) as Array<Record<string, any>>)
    : ((((
        await tenantDb.execute(sql`
          SELECT *
          FROM ai_policy_recommendation_decisions
          WHERE office_id = ${input.officeId}
        `)
      ) as any).rows ?? []) as Array<Record<string, any>>);

  const filteredRows = rows.filter((row) => {
    const createdAt = new Date(toIso(row.created_at) ?? 0).getTime();
    if (Number.isFinite(createdAt) && createdAt < cutoff) return false;
    if (input.taxonomy && row.taxonomy !== input.taxonomy) return false;
    if (input.decision && row.decision !== input.decision) return false;
    return true;
  });

  const feedbackRows = (isInMemoryTenantDb(tenantDb)
    ? (((tenantDb.state.policyRecommendationFeedback ?? []) as Array<Record<string, any>>).filter(
        (row) => row.office_id === input.officeId
      ) as Array<Record<string, any>>)
    : ((((
        await tenantDb.execute(sql`
          SELECT recommendation_id, feedback_value, created_at
          FROM ai_policy_recommendation_feedback
          WHERE office_id = ${input.officeId}
        `)
      ) as any).rows ?? []) as Array<Record<string, any>>)
  ).filter((row) => {
    const createdAt = new Date(toIso(row.created_at) ?? 0).getTime();
    return !Number.isFinite(createdAt) || createdAt >= cutoff;
  });

  const applyRows = (isInMemoryTenantDb(tenantDb)
    ? (((tenantDb.state.policyRecommendationApplyEvents ?? []) as Array<Record<string, any>>).filter(
        (row) => row.office_id === input.officeId
      ) as Array<Record<string, any>>)
    : ((((
        await tenantDb.execute(sql`
          SELECT recommendation_id, taxonomy, status, created_at
          FROM ai_policy_recommendation_apply_events
          WHERE office_id = ${input.officeId}
        `)
      ) as any).rows ?? []) as Array<Record<string, any>>)
  ).filter((row) => {
    const createdAt = new Date(toIso(row.created_at) ?? 0).getTime();
    return !Number.isFinite(createdAt) || createdAt >= cutoff;
  });

  const zeroTotals = {
    qualifiedRendered: 0,
    qualifiedSuppressedByCap: 0,
    suppressedByThreshold: 0,
    suppressedByPredicate: 0,
    suppressedByMissingTarget: 0,
    suppressedByApplyIneligible: 0,
  };
  type EvaluationTotals = typeof zeroTotals;

  const taxonomies: InterventionPolicyRecommendationTaxonomy[] = [
    "snooze_policy_adjustment",
    "escalation_policy_adjustment",
    "assignee_load_balancing",
    "disconnect_playbook_change",
    "monitor_only",
  ];

  return {
    window,
    generatedAt: new Date().toISOString(),
    filters: {
      taxonomy: input.taxonomy ?? null,
      decision: (input.decision as any) ?? null,
    },
    totals: filteredRows.reduce<EvaluationTotals>((acc, row) => {
      if (row.decision === "qualified_rendered") acc.qualifiedRendered++;
      if (row.decision === "qualified_suppressed_by_cap") acc.qualifiedSuppressedByCap++;
      if (row.decision === "suppressed_by_threshold") acc.suppressedByThreshold++;
      if (row.decision === "suppressed_by_predicate") acc.suppressedByPredicate++;
      if (row.decision === "suppressed_by_missing_target") acc.suppressedByMissingTarget++;
      if (row.decision === "suppressed_by_apply_ineligible") acc.suppressedByApplyIneligible++;
      return acc;
    }, { ...zeroTotals }),
    byTaxonomy: taxonomies.map((taxonomy) => {
      const taxonomyRows = filteredRows.filter((row) => row.taxonomy === taxonomy);
      return {
        taxonomy,
        counts: taxonomyRows.reduce<EvaluationTotals>((acc, row) => {
          if (row.decision === "qualified_rendered") acc.qualifiedRendered++;
          if (row.decision === "qualified_suppressed_by_cap") acc.qualifiedSuppressedByCap++;
          if (row.decision === "suppressed_by_threshold") acc.suppressedByThreshold++;
          if (row.decision === "suppressed_by_predicate") acc.suppressedByPredicate++;
          if (row.decision === "suppressed_by_missing_target") acc.suppressedByMissingTarget++;
          if (row.decision === "suppressed_by_apply_ineligible") acc.suppressedByApplyIneligible++;
          return acc;
        }, { ...zeroTotals }),
      };
    }),
    feedback: taxonomies.map((taxonomy) => {
      const ids = new Set(filteredRows.filter((row) => row.taxonomy === taxonomy && row.recommendation_id).map((row) => row.recommendation_id));
      const taxonomyFeedback = feedbackRows.filter((row) => ids.has(row.recommendation_id));
      return {
        taxonomy,
        helpfulCount: taxonomyFeedback.filter((row) => row.feedback_value === "helpful").length,
        notUsefulCount: taxonomyFeedback.filter((row) => row.feedback_value === "not_useful").length,
        wrongDirectionCount: taxonomyFeedback.filter((row) => row.feedback_value === "wrong_direction").length,
      };
    }),
    apply: taxonomies.map((taxonomy) => {
      const taxonomyApply = applyRows.filter((row) => row.taxonomy === taxonomy);
      return {
        taxonomy,
        appliedCount: taxonomyApply.filter((row) => row.status === "applied").length,
        appliedNoopCount: taxonomyApply.filter((row) => row.status === "applied_noop").length,
        rejectedCount: taxonomyApply.filter((row) => String(row.status).startsWith("rejected")).length,
      };
    }),
  };
}
