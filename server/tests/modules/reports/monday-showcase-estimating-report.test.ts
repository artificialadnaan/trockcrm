import { describe, expect, it } from "vitest";
import { assembleEstimatingReport } from "../../../src/modules/reports/monday-showcase-service.js";

describe("Monday Showcase A1 estimating-report assembly", () => {
  it("keeps the live queue separate, preserves zeroes, and folds every visible RFP/sent total from its row set", () => {
    const report = assembleEstimatingReport({
      currentAsOf: "2026-08-26T15:30:00.000Z",
      currentEstimatingRows: [
        {
          id: "current-1",
          name: "Oldest current estimate",
          deal_number: "D-100",
          project_number: "P-100",
          stage_slug: "estimating",
          dd_estimate: "100",
          days_in_stage: "17",
        },
        {
          id: "current-2",
          name: "Missing DD",
          deal_number: "D-101",
          project_number: null,
          stage_slug: "service_estimating",
          dd_estimate: null,
          days_in_stage: "2",
        },
      ],
      rfpInitiatedRows: [
        {
          id: "rfp-1",
          name: "Assigned RFP",
          deal_number: "D-200",
          project_number: "P-200",
          requested_at: "2026-08-25T16:00:00.000Z",
          rfp_approval_status: "pending",
          assigned_rep_id: "rep-a",
          assigned_rep_name: "Alex",
          dd_estimate: "100",
        },
        {
          id: "rfp-2",
          name: "Unassigned zero DD",
          deal_number: "D-201",
          project_number: null,
          requested_at: "2026-08-25T15:00:00.000Z",
          rfp_approval_status: "approved",
          assigned_rep_id: null,
          assigned_rep_name: null,
          dd_estimate: "0",
        },
        {
          id: "rfp-3",
          name: "Missing DD",
          deal_number: "D-202",
          project_number: null,
          requested_at: "2026-08-24T15:00:00.000Z",
          rfp_approval_status: null,
          assigned_rep_id: "rep-a",
          assigned_rep_name: "Alex",
          dd_estimate: null,
        },
      ],
      estimateSentRows: [
        {
          id: "sent-1",
          name: "Small high-margin project",
          deal_number: "D-300",
          project_number: "P-300",
          sent_at: "2026-08-25T18:00:00.000Z",
          dd_estimate: "100",
          latest_bid_board_total_sales: "120",
          margin_percent: "20",
        },
        {
          id: "sent-2",
          name: "Large lower-margin project",
          deal_number: "D-301",
          project_number: "P-301",
          sent_at: "2026-08-25T17:00:00.000Z",
          dd_estimate: "1000",
          latest_bid_board_total_sales: "1100",
          margin_percent: "10",
        },
        {
          id: "sent-3",
          name: "Zero DD remains a real value",
          deal_number: "D-302",
          project_number: null,
          sent_at: "2026-08-25T16:00:00.000Z",
          dd_estimate: "0",
          latest_bid_board_total_sales: "20",
          margin_percent: "40",
        },
        {
          id: "sent-4",
          name: "No latest total",
          deal_number: "D-303",
          project_number: null,
          sent_at: "2026-08-25T15:00:00.000Z",
          dd_estimate: "50",
          latest_bid_board_total_sales: null,
          margin_percent: "30",
        },
      ],
    });

    expect(report.currentAsOf).toBe("2026-08-26T15:30:00.000Z");
    expect(report.currentEstimating).toMatchObject({ count: 2, ddValue: 100, missingDdCount: 1 });
    expect(report.currentEstimating.projects[1]).toMatchObject({ stageLabel: "Service estimating", ddEstimate: null, daysInStage: 2 });

    expect(report.newRfps).toMatchObject({ count: 3, ddValue: 100, missingDdCount: 1 });
    expect(report.newRfps.projects.find((project) => project.id === "rfp-2")?.ddEstimate).toBe(0);
    expect(report.rfpBySalesperson).toEqual([
      { repId: "rep-a", repName: "Alex", count: 2, ddValue: 100, missingDdCount: 1 },
      { repId: null, repName: "Unassigned", count: 1, ddValue: 0, missingDdCount: 0 },
    ]);

    expect(report.estimatesSent.count).toBe(4);
    expect(report.estimatesSent.latestBidBoardTotalSales).toBe(1240);
    expect(report.estimatesSent.missingSentValueCount).toBe(1);
    expect(report.estimatesSent.projects.find((project) => project.id === "sent-3")).toMatchObject({
      ddEstimate: 0,
      varianceAmount: 20,
      variancePercent: null,
    });
    expect(report.estimatesSent.comparison).toEqual({
      dollarComparableCount: 3,
      percentageComparableCount: 2,
      dollarComparableDdValue: 1100,
      dollarComparableLatestBidBoardTotalSales: 1240,
      varianceAmount: 140,
      percentageComparableDdValue: 1100,
      percentageComparableLatestBidBoardTotalSales: 1220,
      variancePercent: 10.91,
    });

    // Weighted, not an arithmetic mean: (120×20 + 1100×10 + 20×40) / 1240 = 11.45%, not 23.33%.
    expect(report.estimatesSent.margin).toEqual({
      projectCount: 3,
      latestBidBoardTotalSales: 1240,
      blendedPercent: 11.45,
    });
    expect(report.estimatesSent.missingMarginCount).toBe(0);
  });
});
