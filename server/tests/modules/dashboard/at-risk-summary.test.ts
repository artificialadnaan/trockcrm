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
        stageSlug: "opportunity",
        workflowRoute: "normal",
        stageEnteredAt: "2026-05-12T12:00:00.000Z",
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
    expect(buildDashboardAtRiskDeals(rows, "director", now)).toEqual([]);
  });
});
