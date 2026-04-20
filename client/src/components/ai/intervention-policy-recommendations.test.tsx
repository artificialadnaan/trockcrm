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
  it("renders yield and history details when the review panel is opened by default", () => {
    const html = renderToStaticMarkup(
      <InterventionPolicyRecommendationsSection
        view={recommendationView}
        onRefresh={() => {}}
        defaultShowReview
      />
    );

    expect(html).toContain("Yield and decision history");
    expect(html).toContain("Window rendered: 4");
    expect(html).toContain("Next action: review threshold floor");
    expect(html).toContain("threshold_not_met · 5");
    expect(html).toContain("Rendered 3");
    expect(html).toContain("monitor_only");
    expect(html).toContain("Applied to waiting-on-customer snooze policy.");
    expect(html).toContain("Qualification diagnostics");
    expect(html).toContain("review threshold floor in code");
    expect(html).toContain("Latest snapshot truth for the active recommendation snapshot.");
    expect(html).toContain("Non-production validation only");
    expect(html).toContain("scripts/seed-intervention-policy-recommendation-qualification.ts");
  });
});
