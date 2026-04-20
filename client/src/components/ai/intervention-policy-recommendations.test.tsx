import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { InterventionPolicyRecommendationsSection } from "./intervention-policy-recommendations";

const mocks = vi.hoisted(() => ({
  useInterventionPolicyRecommendationReview: vi.fn(),
  regenerateInterventionPolicyRecommendations: vi.fn(),
  submitInterventionPolicyRecommendationFeedback: vi.fn(),
  applyInterventionPolicyRecommendation: vi.fn(),
  revertInterventionPolicyRecommendation: vi.fn(),
}));

vi.mock("@/hooks/use-ai-ops", () => ({
  useInterventionPolicyRecommendationReview: mocks.useInterventionPolicyRecommendationReview,
  regenerateInterventionPolicyRecommendations: mocks.regenerateInterventionPolicyRecommendations,
  submitInterventionPolicyRecommendationFeedback: mocks.submitInterventionPolicyRecommendationFeedback,
  applyInterventionPolicyRecommendation: mocks.applyInterventionPolicyRecommendation,
  revertInterventionPolicyRecommendation: mocks.revertInterventionPolicyRecommendation,
}));

const recommendationView = {
  status: "active",
  snapshot: {
    id: "policy-snapshot-1",
    officeId: "office-1",
    status: "active",
    generatedAt: "2026-04-16T13:10:00.000Z",
    staleAt: "2026-04-17T13:10:00.000Z",
    supersededAt: null,
  },
  recommendations: [],
} as const;

const recommendationReview = {
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
    byTaxonomy: [],
    feedback: [],
    apply: [],
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
      eventType: "applied",
      actorName: "Admin User",
      summary: "Applied to waiting-on-customer snooze policy.",
      occurredAt: "2026-04-16T13:12:00.000Z",
    },
  ],
  diagnostics: {
    window: "last_30_days",
    generatedAt: "2026-04-16T13:15:00.000Z",
    systemDiagnostics: {
      scope: "historical_window",
      dominantBlockers: [
        {
          blocker: "threshold_limited",
          count: 5,
        },
      ],
      recommendedNextAction: "review_threshold_floor_in_code",
    },
    taxonomyDiagnostics: [
      {
        scope: "historical_window",
        taxonomy: "snooze_policy_adjustment",
        renderedCount: 3,
        suppressedCounts: {
          predicateBlocked: 1,
          thresholdBlocked: 5,
          capBlocked: 0,
          missingTarget: 0,
          applyIneligible: 0,
        },
        dominantBlocker: "threshold_limited",
        topSuppressedCandidates: [
          {
            groupingKey: "waiting_on_customer",
            decision: "suppressed_by_threshold",
            suppressionReason: "threshold_not_met",
            score: 53,
            confidence: "medium",
            createdAt: "2026-04-16T13:08:00.000Z",
          },
        ],
        recommendedTuningAction: "review_threshold_floor_in_code",
      },
    ],
    seededValidationStatus: {
      scope: "non_production_only",
      validationMode: "manual_seed_script",
      scriptPath: "scripts/seed-intervention-policy-recommendation-qualification.ts",
      taxonomies: [
        {
          taxonomy: "snooze_policy_adjustment",
          seedPathAvailable: true,
          seedKey: "policy-recommendation-fixture",
          supportsApplyUndo: true,
        },
      ],
    },
  },
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
        reason: "suppressed_by_apply_ineligible",
        count: 2,
      },
    ],
    recommendedNextAction: "review_threshold_floor",
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
  thresholdCalibrationProposals: {
    generatedAt: "2026-04-16T13:15:00.000Z",
    window: "last_30_days",
    selectionSummary: "2 taxonomies are currently the best candidates for a global threshold review.",
    noProposalReason: null,
    proposals: [
      {
        taxonomy: "snooze_policy_adjustment",
        currentThreshold: "minimum breached cases >= 4",
        proposedThreshold: "minimum breached cases >= 3",
        dominantBlocker: "threshold_limited",
        blockerBreakdown: [
          { label: "threshold blocked", count: 5 },
          { label: "predicate blocked", count: 1 },
        ],
        rationale: "Threshold failures dominate while predicate clearance remains healthy enough to justify a bounded adjustment.",
        expectedYieldEffect: "May allow a small number of waiting-on-customer snooze recommendations to render.",
        guardrails: ["Do not materially increase low-confidence output."],
        verificationChecklist: ["Re-check threshold-blocked count after the follow-up calibration deploy."],
      },
    ],
  },
} as const;

beforeEach(() => {
  mocks.useInterventionPolicyRecommendationReview.mockReturnValue({
    data: recommendationReview,
    loading: false,
    error: null,
    refetch: vi.fn(),
  });
  mocks.regenerateInterventionPolicyRecommendations.mockResolvedValue({
    queued: true,
    snapshotId: "policy-snapshot-1",
    status: "active",
  });
  mocks.submitInterventionPolicyRecommendationFeedback.mockResolvedValue({});
  mocks.applyInterventionPolicyRecommendation.mockResolvedValue({});
  mocks.revertInterventionPolicyRecommendation.mockResolvedValue({});
});

describe("InterventionPolicyRecommendationsSection", () => {
  it("renders a compact review summary by default and a structured drawer when opened", () => {
    const collapsedHtml = renderToStaticMarkup(
      <InterventionPolicyRecommendationsSection
        view={recommendationView}
        onRefresh={() => {}}
      />
    );

    expect(collapsedHtml).toContain("Review recommendation quality");
    expect(collapsedHtml).toContain("Attention now:");
    expect(collapsedHtml).not.toContain("Historical window summary");
    expect(collapsedHtml).not.toContain("Qualification diagnostics");
    expect(collapsedHtml).not.toContain("threshold limited");
    expect(collapsedHtml).not.toContain("Window rendered:");
    expect(collapsedHtml).not.toContain("Global threshold proposal");

    const html = renderToStaticMarkup(
      <InterventionPolicyRecommendationsSection
        view={recommendationView}
        onRefresh={() => {}}
        defaultShowReview
      />
    );

    expect(html).toContain("Overview");
    expect(html).toContain("What needs attention now");
    expect(html).toContain("Next safe action");
    expect(html).toContain("Calibration status");
    expect(html).toContain("History");
    expect(html).toContain("Diagnostics");
    expect(html).toContain("Calibration");
    expect(html).toContain("Seeded validation");
    expect(html).not.toContain("Window rendered:");
    expect(html).not.toContain("Historical window summary");
  });

  it("keeps the last rendered review content visible during refetch and summarizes history-limited review state correctly", () => {
    mocks.useInterventionPolicyRecommendationReview.mockReturnValueOnce({
      data: {
        ...recommendationReview,
        diagnostics: {
          ...recommendationReview.diagnostics,
          systemDiagnostics: {
            ...recommendationReview.diagnostics.systemDiagnostics,
            recommendedNextAction: "seed_non_prod_validation",
          },
        },
        thresholdCalibrationProposals: {
          ...recommendationReview.thresholdCalibrationProposals,
          selectionSummary: "No threshold changes are currently recommended.",
          noProposalReason: "predicate_failure_dominates",
          proposals: [],
        },
      },
      loading: true,
      error: null,
      refetch: vi.fn(),
    });

    const html = renderToStaticMarkup(
      <InterventionPolicyRecommendationsSection
        view={recommendationView}
        onRefresh={() => {}}
        defaultShowReview
      />
    );

    expect(html).toContain("Attention now: recommendation history is too thin to justify live changes.");
    expect(html).not.toContain("Loading recommendation history...");
    expect(html).not.toContain("Loading recommendation diagnostics...");
  });
});
