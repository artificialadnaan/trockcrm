import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DirectorScorecardPage } from "./director-scorecard-page";
import { ForecastAccuracyPage } from "./forecast-accuracy-page";
import { RepActivityPage } from "./rep-activity-page";

vi.mock("@/components/reports/report-filter-bar", () => ({
  ReportFilterBar: () => <div>Report Filters</div>,
  useReportFilters: () => ({ filters: { dateFrom: "2026-02-01", dateTo: "2026-05-01", office: "all", ownerNames: [] }, query: { dateFrom: "2026-02-01", dateTo: "2026-05-01", office: "all", ownerNames: [] } }),
}));

vi.mock("@/hooks/use-reports", async () => {
  const actual = await vi.importActual<typeof import("@/hooks/use-reports")>("@/hooks/use-reports");
  return {
    ...actual,
    useDirectorScorecardReport: () => ({ loading: false, error: null, data: {
      kpis: { totalPipelineValue: 1000000, openDealCount: 10, forecastCommit: 400000, forecastBestCase: 700000, winRate: 35 },
      risks: { dealsAtRisk: 2, dealsAtRiskValue: 200000, stalledAccounts: 3, overdueTasks: 1, missedFollowUps: 4 },
      repPerformance: [],
      officeComparison: [],
      topAtRiskDeals: [],
    } }),
    useRepActivityReport: () => ({ loading: false, error: null, data: {
      kpis: { totalTouchpoints: 12, dealsWorked: 5, calls: 3, emails: 7, meetings: 1, followUpsCompleted: 1 },
      timeline: [{ date: "2026-05-01", touchpoints: 4 }],
      activityByType: [{ type: "Email", count: 7 }],
      stalledAccounts: [],
      repSummary: [],
    } }),
    useForecastAccuracyReport: () => ({ loading: false, error: null, data: {
      kpis: { commit: 100000, bestCase: 250000, pipelineWeighted: 50000, wonActual: 90000 },
      monthly: [{ month: "2026-05", commit: 100000, bestCase: 250000, pipelineWeighted: 50000, wonActual: 90000 }],
      accuracy: { variancePercent: -10 },
      pipelineAtRisk: [],
    } }),
  };
});

function htmlFor(node: React.ReactElement) {
  return renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>).replace(/\s+/g, " ");
}

describe("performance report pages", () => {
  it("renders Director Scorecard with filters and KPI labels", () => {
    const html = htmlFor(<DirectorScorecardPage />);
    expect(html).toContain("Director Scorecard");
    expect(html).toContain("Report Filters");
    expect(html).toContain("Total Pipeline Value");
  });

  it("renders Rep Activity with filters and activity labels", () => {
    const html = htmlFor(<RepActivityPage />);
    expect(html).toContain("Rep Activity");
    expect(html).toContain("Total Touchpoints");
    expect(html).toContain("Activity Timeline");
  });

  it("renders Forecast Accuracy with forecast labels", () => {
    const html = htmlFor(<ForecastAccuracyPage />);
    expect(html).toContain("Forecast Accuracy");
    expect(html).toContain("Commit");
    expect(html).toContain("Pipeline At Risk");
  });
});
