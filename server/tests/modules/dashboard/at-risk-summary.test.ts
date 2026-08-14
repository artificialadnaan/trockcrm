import { describe, expect, it } from "vitest";

describe("dashboard At Risk summary", () => {
  it("computes count and value from the same role-relative hold-aware deal population", async () => {
    const { buildDashboardAtRiskSummary, buildDashboardAtRiskDeals } = await import("../../../src/modules/dashboard/service.js");
    const now = new Date("2026-05-22T12:00:00.000Z");
    const rows = [
      {
        dealId: "rep-risk",
        dealValue: 1000,
        stageSlug: "opportunity",
        workflowRoute: "normal",
        stageEnteredAt: "2026-05-12T12:00:00.000Z",
        onHold: false,
        onHoldStartedAt: null,
        onHoldAccumulatedSeconds: 0,
        onHoldAccumulatedSecondsAtStageEntry: 0,
      },
      {
        dealId: "leadership-only-safe",
        dealValue: 2000,
        stageName: "Opportunity",
        stageSlug: "estimate_under_review",
        workflowRoute: "normal",
        stageEnteredAt: "2026-05-17T12:00:00.000Z",
        onHold: false,
        onHoldStartedAt: null,
        onHoldAccumulatedSeconds: 0,
        onHoldAccumulatedSecondsAtStageEntry: 0,
      },
      {
        dealId: "paused",
        dealValue: 3000,
        stageSlug: "opportunity",
        workflowRoute: "normal",
        stageEnteredAt: "2026-05-02T12:00:00.000Z",
        onHold: true,
        onHoldStartedAt: "2026-05-02T12:00:00.000Z",
        onHoldAccumulatedSeconds: 0,
        onHoldAccumulatedSecondsAtStageEntry: 0,
      },
      {
        dealId: "auto-held-by-close-target",
        dealValue: 9000,
        stageName: "Opportunity",
        stageSlug: "opportunity",
        workflowRoute: "normal",
        stageEnteredAt: "2026-04-01T12:00:00.000Z",
        onHold: false,
        onHoldStartedAt: null,
        onHoldAccumulatedSeconds: 0,
        onHoldAccumulatedSecondsAtStageEntry: 0,
        expectedCloseDate: "2026-09-01",
      },
      {
        // Over-SLA but POSTPONED to a near (11-day) target. A "Move Close Date" postponement quiets the
        // SLA on the dashboard too (applyCloseTargetSuppression:true), matching the deal-detail "Postponed"
        // state — so this deal must NOT be counted at-risk even though it's short of the 90-day auto-hold.
        dealId: "near-postponed",
        dealValue: 7000,
        stageName: "Opportunity",
        stageSlug: "opportunity",
        workflowRoute: "normal",
        stageEnteredAt: "2026-04-01T12:00:00.000Z",
        onHold: false,
        onHoldStartedAt: null,
        onHoldAccumulatedSeconds: 0,
        onHoldAccumulatedSecondsAtStageEntry: 0,
        expectedCloseDate: "2026-06-02",
      },
      {
        dealId: "terminal",
        dealValue: 4000,
        stageSlug: "won",
        workflowRoute: "normal",
        stageEnteredAt: "2026-04-01T12:00:00.000Z",
        onHold: false,
        onHoldStartedAt: null,
        onHoldAccumulatedSeconds: 0,
        onHoldAccumulatedSecondsAtStageEntry: 0,
      },
    ];

    expect(buildDashboardAtRiskSummary(rows, "rep", now)).toEqual({
      count: 2,
      totalValue: 3000,
    });
    expect(buildDashboardAtRiskSummary(rows, "director", now)).toEqual({
      count: 0,
      totalValue: 0,
    });
    expect(buildDashboardAtRiskDeals(rows, "rep", now).map((deal) => deal.dealId)).toEqual([
      "rep-risk",
      "leadership-only-safe",
    ]);
    expect(buildDashboardAtRiskDeals(rows, "rep", now)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ dealId: "auto-held-by-close-target" })])
    );
    expect(buildDashboardAtRiskDeals(rows, "rep", now)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ dealId: "near-postponed" })])
    );
    expect(buildDashboardAtRiskDeals(rows, "rep", now)[1]).toMatchObject({
      dealId: "leadership-only-safe",
      stageName: "Estimate Under Review",
      atRisk: {
        canonicalStageSlug: "estimate_under_review",
        thresholdDays: 3,
      },
    });
    expect(buildDashboardAtRiskDeals(rows, "director", now)).toEqual([]);
  });

  it("builds dashboard stale deal rows from the same hold-aware engine population", async () => {
    const { buildDashboardAtRiskSummary, buildDashboardAtRiskStaleDeals } = await import("../../../src/modules/dashboard/service.js");
    const now = new Date("2026-05-22T12:00:00.000Z");
    const rows = [
      {
        dealId: "active-risk",
        dealNumber: "DFW-1",
        dealValue: 1000,
        stageId: "stage-opportunity",
        stageName: "Opportunity",
        stageSlug: "opportunity",
        repId: "rep-1",
        repName: "Avery Rep",
        workflowRoute: "normal",
        stageEnteredAt: "2026-04-01T12:00:00.000Z",
        onHold: false,
        onHoldStartedAt: null,
        onHoldAccumulatedSeconds: 0,
        onHoldAccumulatedSecondsAtStageEntry: 0,
      },
      {
        dealId: "held-risk",
        dealNumber: "DFW-2",
        dealValue: 2000,
        stageId: "stage-opportunity",
        stageName: "Opportunity",
        stageSlug: "opportunity",
        repId: "rep-1",
        repName: "Avery Rep",
        workflowRoute: "normal",
        stageEnteredAt: "2026-04-01T12:00:00.000Z",
        onHold: true,
        onHoldStartedAt: "2026-04-15T12:00:00.000Z",
        onHoldAccumulatedSeconds: 0,
        onHoldAccumulatedSecondsAtStageEntry: 0,
      },
      {
        dealId: "former-hold-risk",
        dealNumber: "DFW-3",
        dealValue: 3000,
        stageId: "stage-contract",
        stageName: "Contract",
        stageSlug: "contract",
        repId: "rep-2",
        repName: "Blake Rep",
        workflowRoute: "normal",
        // 21 days in the Contract stage. PR #481 raised the rep Contract SLA threshold 2 -> 7 days,
        // so the original 3-days-in-stage fixture is correctly no longer at risk; bump it past the
        // current 7-day threshold to keep demonstrating an off-hold downstream at-risk deal.
        stageEnteredAt: "2026-05-01T12:00:00.000Z",
        onHold: false,
        onHoldStartedAt: null,
        onHoldAccumulatedSeconds: 0,
        onHoldAccumulatedSecondsAtStageEntry: 0,
      },
    ];

    const staleDeals = buildDashboardAtRiskStaleDeals(rows, "rep", now);

    expect(staleDeals.map((deal) => deal.dealId)).toEqual(["active-risk", "former-hold-risk"]);
    expect(staleDeals).not.toEqual(expect.arrayContaining([expect.objectContaining({ dealId: "held-risk" })]));
    expect(buildDashboardAtRiskSummary(rows, "rep", now)).toEqual({
      count: staleDeals.length,
      totalValue: staleDeals.reduce((sum, deal) => sum + deal.dealValue, 0),
    });
  });

  it("builds downstream bottlenecks from engine at-risk results instead of raw stale thresholds", async () => {
    const { buildDashboardDownstreamBottlenecks } = await import("../../../src/modules/dashboard/service.js");
    const now = new Date("2026-05-22T12:00:00.000Z");
    const rows = [
      {
        dealId: "under-review-risk",
        dealValue: 1000,
        stageName: "Estimate Under Review",
        stageSlug: "estimate_under_review",
        workflowRoute: "normal",
        stageEnteredAt: "2026-05-17T12:00:00.000Z",
        onHold: false,
        onHoldStartedAt: null,
        onHoldAccumulatedSeconds: 0,
        onHoldAccumulatedSecondsAtStageEntry: 0,
      },
      {
        dealId: "opportunity-risk",
        dealValue: 5000,
        stageName: "Opportunity",
        stageSlug: "opportunity",
        workflowRoute: "normal",
        stageEnteredAt: "2026-04-01T12:00:00.000Z",
        onHold: false,
        onHoldStartedAt: null,
        onHoldAccumulatedSeconds: 0,
        onHoldAccumulatedSecondsAtStageEntry: 0,
      },
      {
        dealId: "legacy-bid-sent-risk",
        dealValue: 3000,
        stageName: "Bid Sent",
        stageSlug: "bid_sent",
        workflowRoute: "normal",
        // 51 days in Bid Sent (canonical estimate_sent_to_client). The rep
        // estimate-sent SLA moved 7 -> 30 days, so an over-SLA bottleneck
        // fixture must now exceed 30 days in stage to stay at risk.
        stageEnteredAt: "2026-04-01T12:00:00.000Z",
        onHold: false,
        onHoldStartedAt: null,
        onHoldAccumulatedSeconds: 0,
        onHoldAccumulatedSecondsAtStageEntry: 0,
      },
      {
        dealId: "held-legacy-bid-sent",
        dealValue: 4000,
        stageName: "Bid Sent",
        stageSlug: "bid_sent",
        workflowRoute: "normal",
        stageEnteredAt: "2026-05-01T12:00:00.000Z",
        onHold: true,
        onHoldStartedAt: "2026-05-01T12:00:00.000Z",
        onHoldAccumulatedSeconds: 0,
        onHoldAccumulatedSecondsAtStageEntry: 0,
      },
      {
        dealId: "held-contract",
        dealValue: 2000,
        stageName: "Contract",
        stageSlug: "contract",
        workflowRoute: "normal",
        stageEnteredAt: "2026-05-01T12:00:00.000Z",
        onHold: true,
        onHoldStartedAt: "2026-05-01T12:00:00.000Z",
        onHoldAccumulatedSeconds: 0,
        onHoldAccumulatedSecondsAtStageEntry: 0,
      },
    ];

    const bottlenecks = buildDashboardDownstreamBottlenecks(rows, "rep", now);

    // Bottlenecks sort by time past threshold (most overdue first). With the
    // rep estimate-sent SLA at 30 days, legacy-bid-sent-risk is 51 days in
    // stage (21 days over) and now leads under-review-risk (5 days, 2 over).
    expect(bottlenecks.map((deal) => deal.dealId)).toEqual([
      "legacy-bid-sent-risk",
      "under-review-risk",
    ]);
    expect(bottlenecks[0]).toMatchObject({
      dealId: "legacy-bid-sent-risk",
      daysInStage: 51,
      staleThresholdDays: 30,
      atRisk: {
        canonicalStageSlug: "estimate_sent_to_client",
        isAtRisk: true,
        reason: "threshold_reached",
      },
    });
    expect(bottlenecks[1]).toMatchObject({
      dealId: "under-review-risk",
      daysInStage: 5,
      staleThresholdDays: 3,
      atRisk: {
        canonicalStageSlug: "estimate_under_review",
        isAtRisk: true,
        reason: "threshold_reached",
      },
    });
  });
});
