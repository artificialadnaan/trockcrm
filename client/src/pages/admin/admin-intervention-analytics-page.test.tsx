import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagerAlertSnapshot } from "@/hooks/use-ai-ops";

import {
  AdminInterventionAnalyticsPage,
  selectNewestManagerAlertSnapshot,
  shouldShowManagerAlertHookError,
} from "./admin-intervention-analytics-page";

const mocks = vi.hoisted(() => ({
  useInterventionAnalytics: vi.fn(),
  useManagerAlertSnapshot: vi.fn(),
  useInterventionPolicyRecommendations: vi.fn(),
  useInterventionPolicyRecommendationReview: vi.fn(),
  regenerateInterventionPolicyRecommendations: vi.fn(),
  submitInterventionPolicyRecommendationFeedback: vi.fn(),
  applyInterventionPolicyRecommendation: vi.fn(),
}));

const analyticsData = {
  summary: {
    openCases: 4,
    overdueCases: 2,
    escalatedCases: 1,
    snoozeOverdueCases: 1,
    repeatOpenCases: 1,
    openCasesBySeverity: { critical: 1, high: 2, medium: 1, low: 0 },
    overdueCasesBySeverity: { critical: 1, high: 1, medium: 0, low: 0 },
  },
  outcomes: {
    clearanceRate30d: 0.5,
    reopenRate30d: 0.25,
    averageAgeOfOpenCases: 3,
    medianAgeOfOpenCases: 2,
    averageAgeToResolution: 4,
    actionVolume30d: { assign: 4, snooze: 3, resolve: 6, escalate: 1 },
  },
  hotspots: {
    assignees: [
      {
        key: "manager-1",
        entityType: "assignee",
        filterValue: "manager-1",
        label: "Manager One",
        openCases: 3,
        overdueCases: 2,
        repeatOpenCases: 1,
        clearanceRate30d: 0.5,
        queueLink: "/admin/interventions?view=overdue&assigneeId=manager-1",
      },
    ],
    disconnectTypes: [],
    reps: [],
    companies: [],
    stages: [],
  },
  breachQueue: {
    items: [
      {
        caseId: "case-1",
        severity: "critical",
        disconnectType: "missing_next_task",
        dealId: "deal-1",
        dealLabel: "D-1001 Alpha Plaza",
        companyId: "company-1",
        companyLabel: "Acme Property Group",
        ageDays: 3,
        assignedTo: "manager-1",
        escalated: true,
        breachReasons: ["overdue", "escalated_open"],
        detailLink: "/admin/interventions?caseId=case-1",
        queueLink: "/admin/interventions?view=overdue&caseId=case-1",
      },
    ],
    totalCount: 1,
    pageSize: 25,
  },
  slaRules: {
    criticalDays: 0,
    highDays: 2,
    mediumDays: 5,
    lowDays: 10,
    timingBasis: "business_days",
  },
  managerBrief: {
    headline: "Intervention pressure is concentrated in 2 overdue, 1 escalated-open cases.",
    summaryWindowLabel: "Compared with the prior 7 days",
    whatChanged: [
      {
        key: "escalations_up",
        tone: "worsened",
        text: "Escalations rose to 2 in the last 7 days from 1 in the prior 7 days.",
        queueLink: "/admin/interventions?view=escalated",
      },
    ],
    focusNow: [
      {
        key: "focus_overdue",
        priority: "high",
        text: "Clear 2 overdue cases before they roll into more escalations.",
        queueLink: "/admin/interventions?view=overdue",
      },
    ],
    emergingPatterns: [
      {
        key: "pattern_1",
        title: "Resolve outcomes are reopening",
        summary: "50% of recent resolve conclusions reopened inside the 30-day window.",
        confidence: "high",
        queueLink: "/admin/intervention-analytics#outcome-effectiveness",
      },
    ],
    groundingNote:
      "Grounded in current intervention analytics, recent intervention history, queue pressure, and outcome-effectiveness trends.",
    error: null,
  },
  outcomeEffectiveness: {
    reopenRateByConclusionFamily: { resolve: 0.5, snooze: 0.25, escalate: 0 },
    reopenRateByResolveCategory: [{ key: "owner_aligned", rate: 0.5, count: 2 }],
    reopenRateBySnoozeReason: [{ key: "waiting_on_customer", rate: 0.25, count: 4 }],
    reopenRateByEscalationReason: [{ key: "manager_visibility_required", rate: 0, count: 1 }],
    conclusionMixByDisconnectType: [{ key: "missing_next_task", resolveCount: 3, snoozeCount: 1, escalateCount: 1 }],
    conclusionMixByActingUser: [{ actorUserId: "director-1", actorName: "Director One", resolveCount: 3, snoozeCount: 1, escalateCount: 1 }],
    conclusionMixByAssigneeAtConclusion: [{ assigneeId: "manager-1", assigneeName: "Manager One", resolveCount: 2, snoozeCount: 1, escalateCount: 1 }],
    medianDaysToReopenByConclusionFamily: [{ key: "resolve", medianDays: 3 }],
  },
};

const managerAlertSnapshot: ManagerAlertSnapshot = {
  id: "snapshot-1",
  officeId: "office-1",
  snapshotKind: "manager_alert_summary",
  snapshotMode: "preview",
  snapshotJson: {
    version: 1,
    officeId: "office-1",
    timezone: "America/Chicago",
    officeLocalDate: "2026-04-16",
    generatedAt: "2026-04-16T13:00:00.000Z",
    link: "/admin/intervention-analytics",
    families: {
      overdueHighCritical: {
        count: 2,
        queueLink: "/admin/interventions?view=overdue",
        caseIds: ["case-1", "case-2"],
      },
      snoozeBreached: {
        count: 1,
        queueLink: "/admin/interventions?view=snooze-breached",
        caseIds: ["case-3"],
      },
      escalatedOpen: {
        count: 1,
        queueLink: "/admin/interventions?view=escalated",
        caseIds: ["case-4"],
      },
      assigneeOverload: {
        count: 1,
        threshold: 15,
        queueLink: null,
        items: [
          {
            assigneeId: "manager-1",
            assigneeLabel: "Manager One",
            totalWeight: 18,
            caseCount: 4,
            queueLink: "/admin/interventions?view=all&assigneeId=manager-1",
          },
        ],
      },
    },
  },
  scannedAt: "2026-04-16T13:00:00.000Z",
  sentAt: null,
  createdAt: "2026-04-16T13:00:00.000Z",
  updatedAt: "2026-04-16T13:00:00.000Z",
};

const policyRecommendationView = {
  status: "active",
  snapshot: {
    id: "policy-snapshot-1",
    officeId: "office-1",
    status: "active",
    generatedAt: "2026-04-16T13:10:00.000Z",
    staleAt: "2026-04-17T13:10:00.000Z",
    supersededAt: null,
  },
  recommendations: [
    {
      id: "11111111-1111-4111-8111-111111111111",
      officeId: "office-1",
      snapshotId: "policy-snapshot-1",
      taxonomy: "snooze_policy_adjustment",
      title: "Tighten waiting-on-customer snoozes",
      statement: "Shorten or gate long waiting-on-customer snoozes for overdue manager-owned cases.",
      whyNow: "Recent waiting-on-customer snoozes are breaching and reopening above the policy threshold.",
      expectedImpact: "Reduce repeat-open volume and shorten breach recovery time.",
      confidence: "high",
      priority: 88,
      suggestedAction: "Review the default waiting-on-customer snooze window and require a stronger next-step plan.",
      counterSignal: "Volume is concentrated in one disconnect type, so confirm the issue is not isolated to a single playbook.",
      renderStatus: "active",
      proposedChange: {
        kind: "snooze_policy_adjustment",
        targetKey: "waiting_on_customer",
        policyLabel: "Waiting on customer",
        currentValue: {
          maxSnoozeDays: 7,
          breachReviewThresholdPercent: 20,
        },
        proposedValue: {
          maxSnoozeDays: 5,
          breachReviewThresholdPercent: 15,
        },
      },
      reviewDetails: {
        decision: "qualified_rendered",
        primaryTrigger: "Waiting on customer snoozes are breaching and reopening above policy thresholds.",
        thresholdSummary: "6 conclusions, 40% breaches, 35% reopen rate.",
        rankingSummary: "Score 88 = impact 34 + volume 19 + persistence 20 + actionability 15.",
        score: 88,
        impactScore: 34,
        volumeScore: 19,
        persistenceScore: 20,
        actionabilityScore: 15,
        usedFallbackCopy: false,
        usedFallbackStructuredPayload: false,
      },
      applyEligibility: {
        eligible: true,
        reason: "eligible",
        message: "This recommendation is eligible for preview and apply.",
      },
      applyStatus: {
        status: "not_applied",
        appliedAt: null,
        appliedBy: null,
        reason: null,
      },
      feedbackSummary: {
        helpfulCount: 2,
        notUsefulCount: 0,
        wrongDirectionCount: 0,
        commentCount: 1,
      },
      feedbackStateForViewer: null,
      evidence: [
        {
          metricKey: "waiting_on_customer_breach_rate",
          label: "Waiting-on-customer breach rate",
          currentValue: 0.4,
          baselineValue: 0.15,
          delta: 0.25,
          window: "last_30_days",
          direction: "up",
        },
      ],
      generatedAt: "2026-04-16T13:10:00.000Z",
      staleAt: "2026-04-17T13:10:00.000Z",
    },
  ],
} as const;

const policyRecommendationReview = {
  snapshot: {
    id: "policy-snapshot-1",
    officeId: "office-1",
    status: "active",
    generatedAt: "2026-04-16T13:10:00.000Z",
    staleAt: "2026-04-17T13:10:00.000Z",
    supersededAt: null,
  },
  summary: {
    window: "last_30_days",
    generatedAt: "2026-04-16T13:15:00.000Z",
    filters: {
      taxonomy: null,
      decision: null,
    },
    totals: {
      qualifiedRendered: 1,
      qualifiedSuppressedByCap: 1,
      suppressedByThreshold: 0,
      suppressedByPredicate: 2,
      suppressedByMissingTarget: 0,
      suppressedByApplyIneligible: 0,
    },
    byTaxonomy: [
      {
        taxonomy: "snooze_policy_adjustment",
        counts: {
          qualifiedRendered: 1,
          qualifiedSuppressedByCap: 0,
          suppressedByThreshold: 0,
          suppressedByPredicate: 1,
          suppressedByMissingTarget: 0,
          suppressedByApplyIneligible: 0,
        },
      },
    ],
    feedback: [
      {
        taxonomy: "snooze_policy_adjustment",
        helpfulCount: 2,
        notUsefulCount: 0,
        wrongDirectionCount: 0,
      },
    ],
    apply: [
      {
        taxonomy: "snooze_policy_adjustment",
        appliedCount: 0,
        appliedNoopCount: 0,
        rejectedCount: 0,
      },
    ],
  },
  emptyStateScope: "latest_snapshot",
  emptyStateReason: null,
  latestDecisionRows: [
    {
      taxonomy: "snooze_policy_adjustment",
      groupingKey: "waiting_on_customer",
      decision: "qualified_rendered",
      suppressionReason: null,
      score: 88,
      confidence: "high",
      usedFallbackCopy: false,
      usedFallbackStructuredPayload: false,
      createdAt: "2026-04-16T13:10:00.000Z",
    },
  ],
  recentHistory: [
    {
      recommendationId: "11111111-1111-4111-8111-111111111111",
      snapshotId: "policy-snapshot-1",
      taxonomy: "snooze_policy_adjustment",
      title: "Tighten waiting-on-customer snoozes",
      eventType: "rendered",
      actorName: null,
      summary: "Rendered in the latest active snapshot.",
      occurredAt: "2026-04-16T13:10:00.000Z",
    },
    {
      recommendationId: "11111111-1111-4111-8111-111111111111",
      snapshotId: "policy-snapshot-1",
      taxonomy: "snooze_policy_adjustment",
      title: "Tighten waiting-on-customer snoozes",
      eventType: "applied",
      actorName: "Admin User",
      summary: "Applied to waiting-on-customer snooze policy.",
      occurredAt: "2026-04-16T13:12:00.000Z",
    },
  ],
  yield: {
    renderedTotals: {
      window: "last_30_days",
      total: 4,
    },
    renderedByTaxonomy: [
      {
        taxonomy: "snooze_policy_adjustment",
        renderedCount: 3,
      },
      {
        taxonomy: "monitor_only",
        renderedCount: 1,
      },
    ],
    dominantSuppressionReasons: [
      {
        reason: "threshold_not_met",
        count: 5,
      },
      {
        reason: "apply_ineligible",
        count: 2,
      },
    ],
    recommendedNextAction: "seed_or_wait_for_more_history",
  },
  tuning: {
    currentThresholds: {
      qualificationFloor: 55,
      strongRecommendationFloor: 70,
      primaryCap: 3,
      secondaryCap: 2,
    },
    guidance: [
      {
        taxonomy: "snooze_policy_adjustment",
        recommendedAction: "review_ranking_cap",
        summary: "This taxonomy is qualifying but being crowded out by ranking cap pressure.",
      },
    ],
  },
} as const;

beforeEach(() => {
  mocks.useInterventionAnalytics.mockReturnValue({
    data: analyticsData,
    loading: false,
    error: null,
    refetch: vi.fn(),
  });
  mocks.useManagerAlertSnapshot.mockReturnValue({
    data: managerAlertSnapshot,
    loading: false,
    error: null,
    refetch: vi.fn(),
  });
  mocks.useInterventionPolicyRecommendations.mockReturnValue({
    data: policyRecommendationView,
    loading: false,
    error: null,
    refetch: vi.fn(),
  });
  mocks.useInterventionPolicyRecommendationReview.mockReturnValue({
    data: policyRecommendationReview,
    loading: false,
    error: null,
    refetch: vi.fn(),
  });
  mocks.regenerateInterventionPolicyRecommendations.mockResolvedValue({
    queued: true,
    snapshotId: "policy-snapshot-1",
    status: "active",
  });
  mocks.submitInterventionPolicyRecommendationFeedback.mockResolvedValue({
    recommendationId: "11111111-1111-4111-8111-111111111111",
    feedbackValue: "helpful",
    comment: null,
  });
  mocks.applyInterventionPolicyRecommendation.mockResolvedValue({
    status: "applied",
    applyEventId: "apply-1",
    recommendationId: "11111111-1111-4111-8111-111111111111",
    snapshotId: "policy-snapshot-1",
    applyStatus: "applied",
    appliedAt: "2026-04-16T13:12:00.000Z",
    appliedBy: "Admin User",
    reason: null,
    beforeState: { maxSnoozeDays: 7, breachReviewThresholdPercent: 20 },
    proposedState: { maxSnoozeDays: 5, breachReviewThresholdPercent: 15 },
    appliedState: { maxSnoozeDays: 5, breachReviewThresholdPercent: 15 },
  });
});

vi.mock("@/components/ai/intervention-analytics-breach-queue", () => ({
  InterventionAnalyticsBreachQueue: () => <div>Breach Queue</div>,
}));

vi.mock("@/components/ai/intervention-analytics-hotspots", () => ({
  InterventionAnalyticsHotspots: () => <div>Hotspots</div>,
}));

vi.mock("@/components/ai/intervention-analytics-outcomes", () => ({
  InterventionAnalyticsOutcomes: () => <div>Outcomes</div>,
}));

vi.mock("@/components/ai/intervention-analytics-sla-rules", () => ({
  InterventionAnalyticsSlaRules: () => <div>SLA Rules</div>,
}));

vi.mock("@/components/ai/intervention-analytics-summary-strip", () => ({
  InterventionAnalyticsSummaryStrip: ({ summary }: { summary: { openCases: number } }) => (
    <div>Open Cases: {summary.openCases}</div>
  ),
}));

vi.mock("@/components/ai/intervention-effectiveness-summary", () => ({
  InterventionEffectivenessSummary: () => <div>Resolution Effectiveness</div>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children }: { children: ReactNode }) => <button>{children}</button>,
  buttonVariants: () => "",
}));

vi.mock("@/components/ui/card", () => ({
  Card: ({ children }: { children: ReactNode }) => <section>{children}</section>,
  CardContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardDescription: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/hooks/use-ai-ops", () => ({
  useInterventionAnalytics: mocks.useInterventionAnalytics,
  useManagerAlertSnapshot: mocks.useManagerAlertSnapshot,
  useInterventionPolicyRecommendations: mocks.useInterventionPolicyRecommendations,
  useInterventionPolicyRecommendationReview: mocks.useInterventionPolicyRecommendationReview,
  regenerateInterventionPolicyRecommendations: mocks.regenerateInterventionPolicyRecommendations,
  submitInterventionPolicyRecommendationFeedback: mocks.submitInterventionPolicyRecommendationFeedback,
  applyInterventionPolicyRecommendation: mocks.applyInterventionPolicyRecommendation,
}));

describe("AdminInterventionAnalyticsPage", () => {
  it("hides stale manager alert hook errors once snapshot content is available", () => {
    expect(shouldShowManagerAlertHookError("fetch failed", null)).toBe(true);
    expect(shouldShowManagerAlertHookError("fetch failed", managerAlertSnapshot)).toBe(false);
  });

  it("keeps the newer manager alert snapshot when older hook data arrives later", () => {
    const newerSnapshot = {
      ...managerAlertSnapshot,
      sentAt: "2026-04-16T13:05:00.000Z",
      updatedAt: "2026-04-16T13:05:00.000Z",
    };
    const olderSnapshot = {
      ...managerAlertSnapshot,
      scannedAt: "2026-04-16T13:00:00.000Z",
      createdAt: "2026-04-16T13:00:00.000Z",
      updatedAt: "2026-04-16T13:00:00.000Z",
    };

    expect(selectNewestManagerAlertSnapshot(newerSnapshot, olderSnapshot)).toBe(newerSnapshot);
    expect(selectNewestManagerAlertSnapshot(olderSnapshot, newerSnapshot)).toBe(newerSnapshot);
  });

  it("renders the manager alerts panel alongside analytics content", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AdminInterventionAnalyticsPage />
      </MemoryRouter>
    );

    expect(html).toContain("Intervention Analytics");
    expect(html).toContain("Manager Brief");
    expect(html).toContain("Queue Health");
    expect(html).toContain("Manager Alerts");
    expect(html).toContain("Outcome Effectiveness");
    expect(html).toContain("Policy Recommendations");
    expect(html).toContain("Tighten waiting-on-customer snoozes");
    expect(html).toContain("snooze_policy_adjustment");
    expect(html).toContain("Reduce repeat-open volume and shorten breach recovery time.");
    expect(html).toContain("Waiting-on-customer breach rate");
    expect(html).toContain("Why this qualified");
    expect(html).toContain("Apply change");
    expect(html).toContain("2 policy values would change.");
    expect(html).toContain("Review recommendation quality");
    expect(html).toContain("Recent history: 2 events");
    expect(html).toContain("Qualification floor 55");
    expect(html).not.toContain("Yield and decision history");
    expect(html).not.toContain("Manager Readout");
    expect(html).toContain("Run Manager Alert Scan");
    expect(html).toContain("Send Alerts");
    expect(html).toContain("Office-local time");
    expect(html).toContain("Open Cases");
    expect(html).toContain("Resolution Effectiveness");
    expect(html).toContain("Breach Queue");
    expect(html).toContain("Manager One");
    expect(html).toContain("Escalations rose to 2 in the last 7 days from 1 in the prior 7 days.");
    expect(html).toContain("Clear 2 overdue cases before they roll into more escalations.");
    expect(html).toContain("Resolve outcomes are reopening");
    expect(html).toContain('href="#queue-health"');
    expect(html).toContain('href="#manager-brief"');
    expect(html).toContain('href="#manager-alerts"');
    expect(html).toContain('href="#outcome-effectiveness"');
    expect(html).toContain('href="#policy-recommendations"');
    expect(html).toContain('id="manager-brief"');
    expect(html).toContain('id="queue-health"');
    expect(html).toContain('id="manager-alerts"');
    expect(html).toContain('id="outcome-effectiveness"');
    expect(html).toContain('id="policy-recommendations"');
    expect(html.indexOf("Manager Brief")).toBeLessThan(html.indexOf("Queue Health"));
    expect(html.indexOf("Manager Brief")).toBeLessThan(html.indexOf("Manager Alerts"));
    expect(html).not.toContain("Policy recommendations are reserved in this baseline.");
  });

  it("preserves source filters on cross-links to the other manager surfaces", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter
        initialEntries={["/admin/intervention-analytics?type=overdue&cluster=manager&trend=critical"]}
      >
        <AdminInterventionAnalyticsPage />
      </MemoryRouter>
    );

    expect(html).toContain('href="/admin/interventions?type=overdue&amp;cluster=manager&amp;trend=critical"');
    expect(html).toContain('href="/admin/sales-process-disconnects?type=overdue&amp;cluster=manager&amp;trend=critical"');
    expect(html).toContain('href="/admin/interventions?view=overdue&amp;type=overdue&amp;cluster=manager&amp;trend=critical"');
    expect(html).toContain('href="/admin/interventions?view=escalated&amp;type=overdue&amp;cluster=manager&amp;trend=critical"');
    expect(html).toContain(
      'href="/admin/intervention-analytics?type=overdue&amp;cluster=manager&amp;trend=critical#outcome-effectiveness"'
    );
    expect(html).toContain(
      'href="/admin/interventions?view=all&amp;assigneeId=manager-1&amp;type=overdue&amp;cluster=manager&amp;trend=critical"'
    );
  });

  it("keeps manager alerts visible when general analytics data is unavailable", () => {
    mocks.useInterventionAnalytics.mockReturnValueOnce({
      data: null,
      loading: false,
      error: null,
      refetch: vi.fn(),
    });

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AdminInterventionAnalyticsPage />
      </MemoryRouter>
    );

    expect(html).toContain("Manager Alerts");
    expect(html).toContain("Intervention analytics are unavailable right now.");
    expect(html).toContain("Run Manager Alert Scan");
  });

  it("renders a missing-snapshot recommendation state with regenerate affordance", () => {
    mocks.useInterventionPolicyRecommendations.mockReturnValueOnce({
      data: {
        status: "missing_snapshot",
        canRegenerate: true,
      },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AdminInterventionAnalyticsPage />
      </MemoryRouter>
    );

    expect(html).toContain("No policy recommendation snapshot is available yet.");
    expect(html).toContain("Generate Recommendations");
  });

  it("renders an undo affordance for an applied recommendation", () => {
    mocks.useInterventionPolicyRecommendations.mockReturnValue({
      data: {
        ...policyRecommendationView,
        recommendations: [
          {
            ...policyRecommendationView.recommendations[0],
            applyStatus: {
              status: "applied",
              appliedAt: "2026-04-16T13:12:00.000Z",
              appliedBy: "Admin User",
              reason: null,
            },
          },
        ],
      },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AdminInterventionAnalyticsPage />
      </MemoryRouter>
    );

    expect(html).toContain("Undo change");
  });

  it("renders an explained empty recommendation state when nothing qualifies", () => {
    mocks.useInterventionPolicyRecommendations.mockReturnValueOnce({
      data: {
        status: "active",
        snapshot: policyRecommendationView.snapshot,
        recommendations: [],
      },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    mocks.useInterventionPolicyRecommendationReview.mockReturnValueOnce({
      data: {
        ...policyRecommendationReview,
        emptyStateReason:
          "In the latest snapshot, candidates were mostly suppressed because the qualification predicates were not met.",
      },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AdminInterventionAnalyticsPage />
      </MemoryRouter>
    );

    expect(html).toContain("No policy changes are recommended right now.");
    expect(html).toContain("qualification predicates were not met");
  });

  it("renders the read-only taxonomy message for review-only recommendations", () => {
    mocks.useInterventionPolicyRecommendations.mockReturnValue({
      data: {
        ...policyRecommendationView,
        recommendations: [
          {
            ...policyRecommendationView.recommendations[0],
            taxonomy: "disconnect_playbook_change",
            title: "Change the missing next task playbook",
            proposedChange: null,
            applyEligibility: {
              eligible: false,
              reason: "read_only_taxonomy",
              message: "This recommendation remains review-only in the current release.",
            },
          },
        ],
      },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AdminInterventionAnalyticsPage />
      </MemoryRouter>
    );

    expect(html).toContain("This recommendation remains review-only in the current release.");
  });
});
