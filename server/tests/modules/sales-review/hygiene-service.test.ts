import { describe, expect, it } from "vitest";
import { evaluateSalesHygieneRecords } from "../../../src/modules/sales-review/hygiene-service.js";

describe("sales hygiene service", () => {
  it("flags missing forecast, next-step, and activity hygiene issues", () => {
    const rows = evaluateSalesHygieneRecords(
      [
        {
          entityType: "deal",
          id: "deal-1",
          name: "Palm Villas",
          assignedRepId: null,
          assignedRepName: null,
          stageId: "estimating",
          decisionMakerName: null,
          budgetStatus: null,
          forecastWindow: null,
          forecastCategory: null,
          forecastConfidencePercent: null,
          nextStep: null,
          nextMilestoneAt: null,
          lastActivityAt: "2026-03-01T00:00:00.000Z",
          updatedAt: "2026-03-01T00:00:00.000Z",
          ownershipSyncStatus: "unmatched",
          unassignedReasonCode: "owner_mapping_failure",
        },
      ],
      { now: new Date("2026-04-20T00:00:00.000Z") }
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].issueTypes).toEqual(
      expect.arrayContaining([
        "unassigned_owner",
        "missing_decision_maker",
        "missing_budget_status",
        "missing_forecast_window",
        "missing_forecast_category",
        "missing_forecast_confidence",
        "missing_next_step",
        "missing_next_milestone",
        "owner_mapping_failure",
        "stale_stage",
        "no_recent_activity",
      ])
    );
  });

  it("returns no rows when the record is current and fully populated", () => {
    const rows = evaluateSalesHygieneRecords(
      [
        {
          entityType: "lead",
          id: "lead-1",
          name: "Austin Towers",
          assignedRepId: "rep-1",
          assignedRepName: "Caleb Rep",
          stageId: "qualified_lead",
          decisionMakerName: "Taylor Buyer",
          budgetStatus: "approved",
          forecastWindow: "30_days",
          forecastCategory: "commit",
          forecastConfidencePercent: 80,
          nextStep: "Owner review",
          nextMilestoneAt: "2026-04-24T00:00:00.000Z",
          lastActivityAt: "2026-04-18T00:00:00.000Z",
          updatedAt: "2026-04-18T00:00:00.000Z",
          ownershipSyncStatus: null,
          unassignedReasonCode: null,
        },
      ],
      { now: new Date("2026-04-20T00:00:00.000Z") }
    );

    expect(rows).toEqual([]);
  });
});
