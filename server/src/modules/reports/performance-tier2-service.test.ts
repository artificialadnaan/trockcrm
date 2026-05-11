import { describe, expect, it } from "vitest";
import {
  buildDirectorScorecardFromRows,
  buildForecastAccuracyFromRows,
  buildRepActivityFromRows,
  normalizePerformanceReportFilters,
  resolveRepActivityScope,
} from "./performance-tier2-service.js";

describe("performance tier 2 report service helpers", () => {
  it("normalizes date, office, and owner filters", () => {
    expect(
      normalizePerformanceReportFilters({
        dateFrom: "2026-02-01",
        dateTo: "2026-05-01",
        office: "dallas",
        ownerNames: "Rep One, Rep Two",
      })
    ).toEqual({
      dateFrom: "2026-02-01",
      dateTo: "2026-05-01",
      office: "dallas",
      ownerNames: ["Rep One", "Rep Two"],
    });
  });

  it("forces rep activity scope to the current rep", () => {
    expect(resolveRepActivityScope({ role: "rep", userId: "rep-current", displayName: "Current Rep" }, ["Other Rep"])).toEqual(["Current Rep"]);
    expect(resolveRepActivityScope({ role: "director", userId: "director-1" }, ["rep-other"])).toEqual(["rep-other"]);
  });

  it("builds director scorecard without exposing UUIDs or stage slugs", () => {
    const result = buildDirectorScorecardFromRows({
      kpiRows: [{ total_pipeline_value: "1250000", open_deal_count: "8", forecast_commit: "500000", forecast_best_case: "900000", win_rate: "42.5" }],
      riskRows: [{ deals_at_risk: "3", deals_at_risk_value: "250000", stalled_accounts: "2", overdue_tasks: "4", missed_follow_ups: "5" }],
      repRows: [{ rep_name: "Derek Barr", open_deals: "3", pipeline_value: "450000", won_this_period: "2", win_rate: "50", activity_score: "18" }],
      officeRows: [{ office_name: "Dallas", pipeline_value: "900000", open_count: "6", win_rate: "40" }],
      atRiskRows: [{
        deal_id: "deal-1",
        deal_name: "The Quinn at Westchase",
        owner_name: "Derek Barr",
        stage_name: "Opportunity",
        days_in_stage: "45",
        value: "1500000",
        last_activity_date: "2026-05-08T12:00:00.000Z",
      }],
    });

    expect(result.kpis.totalPipelineValue).toBe(1250000);
    expect(result.repPerformance[0].repName).toBe("Derek Barr");
    expect(result.topAtRiskDeals[0].stageName).toBe("Opportunity");
    expect(JSON.stringify(result)).not.toContain("stage_slug");
  });

  it("builds rep activity timeline and type totals", () => {
    const result = buildRepActivityFromRows({
      summaryRows: [{ total_touchpoints: "10", deals_worked: "4", calls: "3", emails: "5", meetings: "1", follow_ups_completed: "1" }],
      timelineRows: [{ day: "2026-05-01", touchpoints: "4" }],
      typeRows: [{ type: "email", count: "5" }],
      stalledRows: [{ account_name: "Acme", owner_name: "A Rep", last_activity_date: "2026-04-01T00:00:00.000Z", days_stalled: "40", open_deals: "2", total_open_value: "100000" }],
      repRows: [{ rep_name: "A Rep", touchpoints: "10", active_deals: "4", stalled_accounts: "1" }],
    });

    expect(result.kpis.totalTouchpoints).toBe(10);
    expect(result.timeline[0]).toEqual({ date: "2026-05-01", touchpoints: 4 });
    expect(result.activityByType[0]).toEqual({ type: "Email", count: 5 });
  });

  it("builds forecast accuracy with variance metrics and at-risk deals", () => {
    const result = buildForecastAccuracyFromRows({
      summaryRows: [{ commit: "100000", best_case: "250000", pipeline_weighted: "50000", won_actual: "90000", variance_percent: "-10" }],
      monthlyRows: [{ month: "2026-05", commit: "100000", best_case: "250000", pipeline_weighted: "50000", won_actual: "90000" }],
      atRiskRows: [{ deal_id: "deal-1", deal_name: "Late Deal", owner_name: "A Rep", stage_name: "Contract", value: "100000", expected_close_date: "2026-05-31" }],
    });

    expect(result.kpis.commit).toBe(100000);
    expect(result.accuracy.variancePercent).toBe(-10);
    expect(result.pipelineAtRisk[0].stageName).toBe("Contract");
  });
});
