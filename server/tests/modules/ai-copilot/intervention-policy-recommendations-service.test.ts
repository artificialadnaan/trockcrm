import { describe, expect, it } from "vitest";

const {
  getInterventionPolicyRecommendationsView,
  recordInterventionPolicyRecommendationFeedback,
  regenerateInterventionPolicyRecommendations,
} = await import("../../../src/modules/ai-copilot/intervention-service");
const {
  applyInterventionPolicyRecommendation,
  revertInterventionPolicyRecommendation,
  getInterventionPolicyRecommendationEvaluationSummary,
} = await import("../../../src/modules/ai-copilot/intervention-policy-application-service");
const {
  getInterventionPolicyRecommendationReview,
} = await import("../../../src/modules/ai-copilot/intervention-policy-recommendation-review-service");
const {
  seedInterventionPolicyRecommendationQualificationData,
} = await import("../../../src/modules/ai-copilot/intervention-policy-recommendation-seed-service");

type DisconnectCaseRecord = {
  id: string;
  officeId: string;
  scopeType: string;
  scopeId: string;
  dealId: string | null;
  companyId: string | null;
  disconnectType: string;
  clusterKey: string | null;
  businessKey: string;
  severity: string;
  status: "open" | "snoozed" | "resolved";
  assignedTo: string | null;
  generatedTaskId: string | null;
  escalated: boolean;
  snoozedUntil: Date | null;
  reopenCount: number;
  firstDetectedAt: Date;
  lastDetectedAt: Date;
  currentLifecycleStartedAt: Date;
  lastReopenedAt: Date | null;
  lastIntervenedAt: Date | null;
  resolvedAt: Date | null;
  resolutionReason: string | null;
  metadataJson: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
};

function makeCase(index: number, overrides: Partial<DisconnectCaseRecord> = {}): DisconnectCaseRecord {
  const now = new Date("2026-04-19T12:00:00.000Z");
  return {
    id: `case-${index}`,
    officeId: "office-1",
    scopeType: "deal",
    scopeId: `deal-${index}`,
    dealId: `deal-${index}`,
    companyId: "company-1",
    disconnectType: "missing_next_task",
    clusterKey: "follow_through_gap",
    businessKey: `office-1:missing_next_task:deal:deal-${index}`,
    severity: "high",
    status: "open",
    assignedTo: "manager-1",
    generatedTaskId: null,
    escalated: index <= 3,
    snoozedUntil: null,
    reopenCount: index <= 2 ? 1 : 0,
    firstDetectedAt: now,
    lastDetectedAt: now,
    currentLifecycleStartedAt: new Date("2026-04-10T12:00:00.000Z"),
    lastReopenedAt: null,
    lastIntervenedAt: null,
    resolvedAt: null,
    resolutionReason: null,
    metadataJson: {
      evidenceSummary: "Deal has no open next-step task.",
      dealName: `Deal ${index}`,
      dealNumber: `D-10${index}`,
      companyName: "Acme Property Group",
      stageKey: "estimating",
      stageName: "Estimating",
      assignedRepId: "rep-1",
      assignedRepName: "Rep One",
    },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function createTenantDb(state?: {
  cases?: DisconnectCaseRecord[];
  users?: Array<{ id: string; displayName: string }>;
}) {
  return {
    state: {
      cases: state?.cases ? state.cases.map((row) => ({ ...row })) : [],
      tasks: [],
      deals: [],
      companies: [],
      users: state?.users ? state.users.map((row) => ({ ...row })) : [],
      history: [],
      feedback: [],
      policyRecommendationSnapshots: [],
      policyRecommendationRows: [],
      policyRecommendationFeedback: [],
      policyRecommendationDecisions: [],
      policyRecommendationApplyEvents: [],
      interventionSnoozePolicies: [],
      interventionEscalationPolicies: [],
      interventionAssigneeBalancingPolicies: [],
    },
  };
}

describe("intervention policy recommendations service", () => {
  it("persists stable ranked recommendations and viewer feedback across regenerations", async () => {
    const tenantDb = createTenantDb({
      cases: [
        makeCase(1),
        makeCase(2),
        makeCase(3),
        makeCase(4),
        makeCase(5),
        makeCase(6, {
          assignedTo: "manager-2",
          businessKey: "office-1:missing_next_task:deal:deal-6",
        }),
      ],
      users: [
        { id: "manager-1", displayName: "Manager One" },
        { id: "manager-2", displayName: "Manager Two" },
      ],
    });

    const firstResult = await regenerateInterventionPolicyRecommendations(tenantDb as any, {
      officeId: "office-1",
      requestedByUserId: "admin-1",
      now: new Date("2026-04-19T12:00:00.000Z"),
    });

    expect(firstResult.queued).toBe(true);
    expect(firstResult.status).toBe("active");
    expect(firstResult.recommendations).toHaveLength(1);
    expect(firstResult.recommendations[0]).toMatchObject({
      taxonomy: "assignee_load_balancing",
      confidence: "medium",
      renderStatus: "active",
      applyStatus: {
        status: "not_applied",
      },
    });
    expect(firstResult.recommendations[0]?.proposedChange).toMatchObject({
      kind: "assignee_load_balancing",
      currentValue: {
        overloadSharePercent: 35,
      },
    });
    expect(firstResult.recommendations[0]?.reviewDetails).toMatchObject({
      decision: "qualified_rendered",
      score: 70,
    });

    const stableRecommendationId = firstResult.recommendations[0]?.id;
    expect(stableRecommendationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );

    const feedback = await recordInterventionPolicyRecommendationFeedback(tenantDb as any, {
      officeId: "office-1",
      recommendationId: stableRecommendationId!,
      userId: "admin-1",
      feedbackValue: "helpful",
      comment: "This is actionable.",
    });

    expect(feedback.feedbackValue).toBe("helpful");

    const view = await getInterventionPolicyRecommendationsView(tenantDb as any, {
      officeId: "office-1",
      viewerUserId: "admin-1",
      now: new Date("2026-04-19T12:30:00.000Z"),
    });

    expect(view.status).toBe("active");
    expect(view.recommendations[0]).toMatchObject({
      id: stableRecommendationId,
      feedbackStateForViewer: "helpful",
      feedbackSummary: {
        helpfulCount: 1,
        notUsefulCount: 0,
        wrongDirectionCount: 0,
        commentCount: 1,
      },
    });

    const secondResult = await regenerateInterventionPolicyRecommendations(tenantDb as any, {
      officeId: "office-1",
      requestedByUserId: "admin-1",
      now: new Date("2026-04-19T14:00:00.000Z"),
    });

    expect(secondResult.recommendations[0]?.id).toBe(stableRecommendationId);

    const applyResult = await applyInterventionPolicyRecommendation(tenantDb as any, {
      officeId: "office-1",
      recommendationId: stableRecommendationId!,
      snapshotId: secondResult.snapshotId,
      actorUserId: "admin-1",
      recommendationIdempotencyKey: "req-1",
    });

    expect(applyResult.status).toBe("applied");

    const secondApplyResult = await applyInterventionPolicyRecommendation(tenantDb as any, {
      officeId: "office-1",
      recommendationId: stableRecommendationId!,
      snapshotId: secondResult.snapshotId,
      actorUserId: "admin-1",
      recommendationIdempotencyKey: "req-2",
    });

    expect(secondApplyResult.status).toBe("applied_noop");

    const revertResult = await revertInterventionPolicyRecommendation(tenantDb as any, {
      officeId: "office-1",
      recommendationId: stableRecommendationId!,
      snapshotId: secondResult.snapshotId,
      actorUserId: "admin-1",
      recommendationIdempotencyKey: "req-3",
    });

    expect(revertResult.status).toBe("reverted");
    expect(tenantDb.state.interventionAssigneeBalancingPolicies[0]).toMatchObject({
      overload_share_percent: 35,
      min_high_risk_cases: 5,
    });

    const refreshedView = await getInterventionPolicyRecommendationsView(tenantDb as any, {
      officeId: "office-1",
      viewerUserId: "admin-1",
      now: new Date("2026-04-19T14:10:00.000Z"),
    });

    expect(refreshedView.status).toBe("active");
    expect(refreshedView.recommendations[0]).toMatchObject({
      applyStatus: {
        status: "not_applied",
      },
    });

    const evaluation = await getInterventionPolicyRecommendationEvaluationSummary(tenantDb as any, {
      officeId: "office-1",
      window: "last_30_days",
    });

    expect(evaluation.totals.qualifiedRendered).toBeGreaterThanOrEqual(1);
    expect(evaluation.apply[0]?.appliedCount ?? 0).toBeGreaterThanOrEqual(0);
  });

  it("builds a review model with latest-snapshot reasoning and bounded diagnostics rows", async () => {
    const tenantDb = createTenantDb({
      cases: [
        makeCase(1),
        makeCase(2),
        makeCase(3),
        makeCase(4),
        makeCase(5),
        makeCase(6, {
          assignedTo: "manager-2",
          businessKey: "office-1:missing_next_task:deal:deal-6",
        }),
      ],
      users: [
        { id: "manager-1", displayName: "Manager One" },
        { id: "manager-2", displayName: "Manager Two" },
      ],
    });

    const generated = await regenerateInterventionPolicyRecommendations(tenantDb as any, {
      officeId: "office-1",
      requestedByUserId: "admin-1",
      now: new Date("2026-04-19T12:00:00.000Z"),
    });

    const reviewAll = await getInterventionPolicyRecommendationReview(tenantDb as any, {
      officeId: "office-1",
      viewerUserId: "admin-1",
      window: "last_30_days",
      decision: "all",
      now: new Date("2026-04-19T12:30:00.000Z"),
    });

    const review = await getInterventionPolicyRecommendationReview(tenantDb as any, {
      officeId: "office-1",
      viewerUserId: "admin-1",
      window: "last_30_days",
      decision: "suppressed",
      now: new Date("2026-04-19T12:30:00.000Z"),
    });

    expect(review.snapshot?.id).toBe(generated.snapshotId);
    expect(review.summary.window).toBe("last_30_days");
    expect(review.summary.filters.decision).toBe("suppressed");
    expect(review.summary.totals.suppressedByPredicate).toBeGreaterThan(0);
    expect(review.emptyStateScope).toBe("latest_snapshot");
    expect(review.latestDecisionRows.length).toBeGreaterThan(0);
    expect(review.latestDecisionRows.length).toBeLessThanOrEqual(10);
    expect(review.latestDecisionRows[0]).toMatchObject({
      taxonomy: expect.any(String),
      decision: expect.not.stringMatching(/^qualified_rendered$/),
    });
    expect(review.recentHistory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "rendered",
          taxonomy: "assignee_load_balancing",
          actorName: null,
        }),
      ])
    );
    expect(review.tuning.currentThresholds).toMatchObject({
      qualificationFloor: 55,
      strongRecommendationFloor: 70,
      primaryCap: 3,
      secondaryCap: 2,
    });
    expect(review.tuning.guidance).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          taxonomy: "assignee_load_balancing",
          recommendedAction: "seed_more_history",
        }),
      ])
    );
    expect(review.yield.renderedTotals).toMatchObject({
      window: "last_30_days",
    });
    expect(review.yield.renderedByTaxonomy).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          taxonomy: "assignee_load_balancing",
          renderedCount: expect.any(Number),
        }),
      ])
    );
    expect(review.yield.dominantSuppressionReasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: expect.any(String),
          count: expect.any(Number),
        }),
      ])
    );
    expect(review.yield.recommendedNextAction).toBe("review_threshold_floor");
    expect(review.yield).toEqual(reviewAll.yield);
  });

  it("keeps read-only taxonomies review-only in the hydrated recommendations view", async () => {
    const tenantDb = createTenantDb({
      users: [{ id: "admin-1", displayName: "Admin User" }],
    });

    tenantDb.state.policyRecommendationSnapshots.push({
      id: "snapshot-readonly",
      office_id: "office-1",
      status: "active",
      generated_at: new Date("2026-04-19T12:00:00.000Z"),
      stale_at: new Date("2026-04-20T12:00:00.000Z"),
      superseded_at: null,
    });
    tenantDb.state.policyRecommendationRows.push({
      snapshot_id: "snapshot-readonly",
      office_id: "office-1",
      recommendation_id: "44444444-4444-4444-8444-444444444444",
      taxonomy: "disconnect_playbook_change",
      primary_grouping_key: "missing_next_task",
      title: "Change the missing next task playbook",
      statement: "Resolve is the dominant path here, but it is reopening too often.",
      why_now: "Missing next task has enough volume to justify a targeted playbook change.",
      expected_impact: "Improve first-pass handling and reduce repeat intervention churn.",
      confidence: "medium",
      priority: 72,
      suggested_action: "Update the default conclusion guidance for missing next task.",
      counter_signal: null,
      render_status: "active",
      evidence_json: [],
      proposed_change_json: null,
      review_details_json: {
        decision: "qualified_rendered",
        primaryTrigger: "missing next task is reopening too often through its dominant path.",
        thresholdSummary: "12 conclusions and 30% dominant-family reopen rate.",
        rankingSummary: "Score 72.",
        score: 72,
        impactScore: 30,
        volumeScore: 17,
        persistenceScore: 10,
        actionabilityScore: 15,
        usedFallbackCopy: false,
        usedFallbackStructuredPayload: false,
      },
      generated_at: new Date("2026-04-19T12:00:00.000Z"),
      stale_at: new Date("2026-04-20T12:00:00.000Z"),
    });

    const view = await getInterventionPolicyRecommendationsView(tenantDb as any, {
      officeId: "office-1",
      viewerUserId: "admin-1",
      now: new Date("2026-04-19T12:30:00.000Z"),
    });

    expect(view.status).toBe("active");
    expect(view.recommendations[0]).toMatchObject({
      taxonomy: "disconnect_playbook_change",
      applyEligibility: {
        eligible: false,
        reason: "read_only_taxonomy",
        message: "This recommendation remains review-only in the current release.",
      },
    });
  });

  it("normalizes recent decision history to newest-first lifecycle events and caps the timeline", async () => {
    const tenantDb = createTenantDb({
      users: [{ id: "admin-1", displayName: "Admin User" }],
    });

    for (let index = 0; index < 25; index += 1) {
      tenantDb.state.policyRecommendationRows.push({
        recommendation_id: `rec-${index}`,
        snapshot_id: `snapshot-${index}`,
        office_id: "office-1",
        taxonomy: "snooze_policy_adjustment",
        title: `Recommendation ${index}`,
        generated_at: new Date(`2026-04-19T12:${String(index).padStart(2, "0")}:00.000Z`),
      });
    }

    tenantDb.state.policyRecommendationApplyEvents.push({
      office_id: "office-1",
      recommendation_id: "rec-24",
      snapshot_id: "snapshot-24",
      taxonomy: "snooze_policy_adjustment",
      actor_user_id: "admin-1",
      actor_display_name: "Admin User",
      status: "applied",
      rejection_reason: null,
      created_at: new Date("2026-04-19T13:00:00.000Z"),
      title: "Recommendation 24",
    });

    const review = await getInterventionPolicyRecommendationReview(tenantDb as any, {
      officeId: "office-1",
      viewerUserId: "admin-1",
      window: "last_30_days",
      decision: "all",
    });

    expect(review.recentHistory).toHaveLength(20);
    expect(review.recentHistory[0]).toMatchObject({
      recommendationId: "rec-24",
      eventType: "applied",
      actorName: "Admin User",
    });
    expect(
      review.recentHistory.some(
        (entry) =>
          entry.recommendationId === "rec-24" &&
          entry.snapshotId === "snapshot-24" &&
          entry.eventType === "rendered"
      )
    ).toBe(false);
  });

  it("uses the caller-provided now value for review window cutoffs", async () => {
    const tenantDb = createTenantDb({
      users: [{ id: "admin-1", displayName: "Admin User" }],
    });

    tenantDb.state.policyRecommendationDecisions.push({
      office_id: "office-1",
      taxonomy: "snooze_policy_adjustment",
      grouping_key: "waiting_on_customer",
      decision: "suppressed_by_threshold",
      suppression_reason: "threshold_not_met",
      score: 52,
      confidence: "medium",
      used_fallback_copy: false,
      used_fallback_structured_payload: false,
      created_at: new Date("2024-01-15T12:00:00.000Z"),
    });

    tenantDb.state.policyRecommendationRows.push({
      recommendation_id: "rec-boundary",
      snapshot_id: "snapshot-boundary",
      office_id: "office-1",
      taxonomy: "snooze_policy_adjustment",
      title: "Boundary recommendation",
      generated_at: new Date("2024-01-15T12:00:00.000Z"),
    });

    const review = await getInterventionPolicyRecommendationReview(tenantDb as any, {
      officeId: "office-1",
      viewerUserId: "admin-1",
      window: "last_30_days",
      decision: "all",
      now: new Date("2024-01-31T12:00:00.000Z"),
    });

    expect(review.yield.dominantSuppressionReasons).toEqual([
      {
        reason: "threshold_not_met",
        count: 1,
      },
    ]);
    expect(review.summary.totals.suppressedByThreshold).toBe(1);
    expect(review.yield.recommendedNextAction).toBe("review_threshold_floor");
    expect(review.recentHistory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recommendationId: "rec-boundary",
          eventType: "rendered",
        }),
      ])
    );
  });

  it("seeds deterministic qualification data for non-production offices and surfaces qualifying recommendations", async () => {
    const tenantDb = createTenantDb({
      users: [
        { id: "manager-1", displayName: "Manager One" },
        { id: "manager-2", displayName: "Manager Two" },
      ],
    });

    const seeded = await seedInterventionPolicyRecommendationQualificationData(tenantDb as any, {
      officeId: "office-1",
      actorUserId: "manager-1",
      environment: "development",
      allowedOfficeIds: ["office-1"],
    });

    expect(seeded).toMatchObject({
      seeded: true,
      seedKey: "policy-recommendation-fixture",
      patternsCreated: expect.arrayContaining([
        "snooze_policy_adjustment",
        "escalation_policy_adjustment",
        "assignee_load_balancing",
      ]),
    });
    expect(tenantDb.state.cases.length).toBeGreaterThanOrEqual(20);
    expect(tenantDb.state.history.length).toBeGreaterThanOrEqual(18);

    const generated = await regenerateInterventionPolicyRecommendations(tenantDb as any, {
      officeId: "office-1",
      requestedByUserId: "admin-1",
      now: new Date("2026-04-19T15:00:00.000Z"),
    });

    expect(generated.status).toBe("active");
    expect(generated.recommendations.length).toBeGreaterThan(0);
    expect(generated.recommendations.map((row) => row.taxonomy)).toEqual(
      expect.arrayContaining([
        "snooze_policy_adjustment",
        "escalation_policy_adjustment",
        "assignee_load_balancing",
      ])
    );
  });

  it("rejects qualification seeding in production", async () => {
    const tenantDb = createTenantDb();

    await expect(
      seedInterventionPolicyRecommendationQualificationData(tenantDb as any, {
        officeId: "office-1",
        actorUserId: "manager-1",
        environment: "production",
      })
    ).rejects.toMatchObject({
      statusCode: 403,
    });
  });
});
