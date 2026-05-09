// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";
import { DirectorDashboardPage } from "./director-dashboard-page";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  useDirectorDashboardMock: vi.fn(),
  useRepPerformanceMock: vi.fn(),
  presetToDateRangeMock: vi.fn(),
}));

vi.mock("@/hooks/use-director-dashboard", () => ({
  useDirectorDashboard: mocks.useDirectorDashboardMock,
  presetToDateRange: mocks.presetToDateRangeMock,
}));

vi.mock("@/hooks/use-rep-performance", () => ({
  useRepPerformance: mocks.useRepPerformanceMock,
}));

vi.mock("@/components/ai/director-blind-spot-list", () => ({
  DirectorBlindSpotList: () => <div>Blind Spots</div>,
}));

vi.mock("@/components/charts/pipeline-bar-chart", () => ({
  PipelineBarChart: ({ data }: { data: Array<{ stageName: string }> }) => (
    <div>{data.map((row) => row.stageName).join(", ")}</div>
  ),
}));

vi.mock("@/components/charts/chart-colors", () => ({
  formatCurrency: (value: number) => `$${value.toLocaleString()}`,
}));

vi.mock("@/components/charts/win-rate-trend-chart", () => ({
  WinRateTrendChart: () => <div>Win Trend</div>,
}));

vi.mock("@/components/dashboard/activity-by-rep-card", () => ({
  ActivityByRepCard: () => <div>Activity by Rep</div>,
}));

vi.mock("@/lib/pipeline-ownership", () => ({
  getWorkflowRouteLabel: (route: "normal" | "service") => (route === "service" ? "Service" : "Normal"),
}));

vi.mock("@/lib/director-dashboard-actions", () => ({
  DIRECTOR_DASHBOARD_ACTIONS: [],
}));

vi.mock("@/lib/stale-lead-dashboard", () => ({
  buildStaleLeadAlertSummary: () => ({
    title: "North Campus",
    detail: "16d stale - Avery Rep - Qualified Lead",
  }),
}));

vi.mock("@/components/ui/card", () => ({
  Card: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  CardContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

function normalize(html: string) {
  return html.replace(/\s+/g, " ").trim();
}

function renderPageHtml() {
  return normalize(
    renderToStaticMarkup(
      <MemoryRouter>
        <DirectorDashboardPage />
      </MemoryRouter>
    )
  );
}

async function renderPageDom() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <MemoryRouter>
        <DirectorDashboardPage />
      </MemoryRouter>
    );
  });
  return {
    container,
    cleanup: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

describe("DirectorDashboardPage", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    mocks.presetToDateRangeMock.mockImplementation((preset: string) => ({
      from: `2026-${preset}-from`,
      to: `2026-${preset}-to`,
    }));
    mocks.useRepPerformanceMock.mockReturnValue({
      data: {
        reps: [
          {
            repId: "rep-1",
            repName: "Avery Rep",
            current: {
              dealsWon: 4,
              dealsLost: 1,
              totalWonValue: 240000,
              activitiesLogged: 49,
              winRate: 67,
              avgDaysToClose: 21,
            },
            previous: null,
            change: {
              dealsWon: 1,
              dealsLost: null,
              totalWonValue: 40000,
              activitiesLogged: 8,
              winRate: 5,
              avgDaysToClose: -2,
            },
            percentChange: {
              dealsWon: 25,
              dealsLost: null,
              totalWonValue: 20,
              activitiesLogged: 18,
              winRate: 8,
              avgDaysToClose: -9,
            },
          },
          {
            repId: "rep-2",
            repName: "Blake Rep",
            current: {
              dealsWon: 2,
              dealsLost: 2,
              totalWonValue: 120000,
              activitiesLogged: 72,
              winRate: 50,
              avgDaysToClose: 28,
            },
            previous: null,
            change: {
              dealsWon: 0,
              dealsLost: null,
              totalWonValue: 0,
              activitiesLogged: 3,
              winRate: -4,
              avgDaysToClose: 1,
            },
            percentChange: {
              dealsWon: 0,
              dealsLost: null,
              totalWonValue: 0,
              activitiesLogged: 4,
              winRate: -7,
              avgDaysToClose: 4,
            },
          },
        ],
        rows: [
          {
            repId: "rep-1",
            repName: "Avery Rep",
            periodKind: "qtd",
            periodStart: "2026-04-01",
            periodEnd: "2026-06-30",
            pipelineValue: 910000,
            closedValue: 240000,
            dealsCount: 6,
            winsCount: 4,
            lossesCount: 1,
            winRate: 67,
            avgDaysToClose: 21,
            atRiskCount: 3,
            activityTotal: 49,
            calls: 10,
            emails: 26,
            meetings: 6,
            notes: 7,
            sparkline8w: [8, 10, 12, 14, 15, 14, 16, 18],
            region: "North DFW",
            computedAt: "2026-05-08T12:00:00Z",
            forecast: 910000,
            goal: 500000,
            goalSource: "manual",
            percentToGoal: 72,
            forecastVsGoal: {
              forecast: 910000,
              goal: 500000,
              goalSource: "manual",
              percentToGoal: 72,
            },
            previous: {
              pipelineValue: 800000,
              closedValue: 200000,
              dealsCount: 5,
              winsCount: 3,
              lossesCount: 1,
              winRate: 62,
              avgDaysToClose: 23,
              atRiskCount: 2,
              activityTotal: 41,
              calls: 8,
              emails: 22,
              meetings: 5,
              notes: 6,
            },
          },
          {
            repId: "rep-2",
            repName: "Blake Rep",
            periodKind: "qtd",
            periodStart: "2026-04-01",
            periodEnd: "2026-06-30",
            pipelineValue: 250000,
            closedValue: 120000,
            dealsCount: 4,
            winsCount: 2,
            lossesCount: 2,
            winRate: 50,
            avgDaysToClose: 28,
            atRiskCount: 0,
            activityTotal: 72,
            calls: 20,
            emails: 38,
            meetings: 7,
            notes: 7,
            sparkline8w: [20, 19, 17, 16, 15, 13, 12, 11],
            region: "East Texas",
            computedAt: "2026-05-08T12:00:00Z",
            forecast: 250000,
            goal: 500000,
            goalSource: "manual",
            percentToGoal: 72,
            forecastVsGoal: {
              forecast: 250000,
              goal: 500000,
              goalSource: "manual",
              percentToGoal: 72,
            },
            previous: {
              pipelineValue: 220000,
              closedValue: 110000,
              dealsCount: 4,
              winsCount: 2,
              lossesCount: 1,
              winRate: 55,
              avgDaysToClose: 27,
              atRiskCount: 0,
              activityTotal: 69,
              calls: 18,
              emails: 36,
              meetings: 7,
              notes: 8,
            },
          },
        ],
        periodLabel: { current: "Current", previous: "Previous" },
        forecastVsGoal: {
          forecast: 360000,
          goal: 500000,
          goalSource: "manual",
          percentToGoal: 72,
        },
      },
      loading: false,
    });
    mocks.useDirectorDashboardMock.mockReturnValue({
      loading: false,
      error: null,
      refetch: vi.fn(),
      data: {
        officeFunnelBuckets: [
          { key: "lead", label: "Lead intake", count: 6, totalValue: 610000, route: "/leads", bucket: "lead" },
          { key: "opportunity", label: "Opportunity", count: 3, totalValue: 300000, route: "/deals", bucket: "opportunity" },
        ],
        repFunnelRows: [
          { repId: "rep-1", repName: "Avery Rep", leads: 2, qualifiedLeads: 3, opportunities: 4, estimating: 1 },
          { repId: "rep-2", repName: "Blake Rep", leads: 1, qualifiedLeads: 1, opportunities: 2, estimating: 3 },
        ],
        repCommissionRows: [],
        repCards: [
          {
            repId: "rep-1",
            repName: "Avery Rep",
            activeDeals: 6,
            pipelineValue: 910000,
            winRate: 67,
            activityScore: 49,
            staleDeals: 1,
            staleLeads: 2,
          },
          {
            repId: "rep-2",
            repName: "Blake Rep",
            activeDeals: 4,
            pipelineValue: 250000,
            winRate: 82,
            activityScore: 74,
            staleDeals: 0,
            staleLeads: 1,
          },
        ],
        pipelineByStage: [{ stageId: "opportunity", stageName: "Opportunity", stageColor: null, dealCount: 3, totalValue: 450000 }],
        winRateTrend: [],
        activityByRep: [],
        staleDeals: [{
          dealId: "deal-1",
          dealNumber: "TR-1001",
          dealName: "Dallas ISD Roof",
          stageName: "Estimating",
          repName: "Avery Rep",
          daysInStage: 22,
          dealValue: 275000,
          workflowRoute: "service",
          bidBoardStageStatus: "blocked",
          regionClassification: "Dallas, TX",
          staleThresholdDays: 14,
        }],
        staleLeads: [{
          leadId: "lead-1",
          leadName: "North Campus",
          companyName: "North Star",
          propertyName: "Austin Campus",
          stageName: "Qualified Lead",
          repName: "Avery Rep",
          daysInStage: 16,
          pipelineType: "normal",
          locationLabel: "Austin, TX",
          estimatedValue: 92000,
          staleThresholdDays: 14,
        }],
        opportunityVsPipeline: {
          opportunityValue: 300000,
          opportunityCount: 2,
          pipelineValue: 610000,
          pipelineCount: 4,
          totalValue: 910000,
          totalCount: 6,
        },
        ddVsPipeline: {
          ddValue: 300000,
          ddCount: 2,
          pipelineValue: 610000,
          pipelineCount: 4,
          totalValue: 910000,
          totalCount: 6,
        },
        crmOwnedProgression: [
          { workflowBucket: "lead", workflowRoute: "normal", stageName: "Qualified Lead", itemCount: 2, totalValue: 125000 },
          { workflowBucket: "opportunity", workflowRoute: "service", stageName: "Opportunity", itemCount: 3, totalValue: 450000 },
        ],
        downstreamBottlenecks: [{
          dealId: "deal-1",
          dealName: "Dallas ISD Roof",
          stageName: "Estimating",
          mirroredStageStatus: "blocked",
          workflowRoute: "service",
          regionClassification: "Dallas, TX",
          dealValue: 275000,
          daysInStage: 22,
          staleThresholdDays: 14,
        }],
        atRiskDeals: [{
          dealId: "deal-1",
          dealName: "Dallas ISD Roof",
          stageName: "Estimating",
          mirroredStageStatus: "blocked",
          workflowRoute: "service",
          regionClassification: "Dallas, TX",
          dealValue: 275000,
          daysInStage: 22,
          staleThresholdDays: 14,
        }],
        forecastVsGoal: {
          forecast: 360000,
          goal: 500000,
          goalSource: "manual",
          percentToGoal: 72,
        },
        activityPulse: [
          { repId: "rep-2", repName: "Blake Rep", calls: 20, emails: 38, meetings: 7, notes: 7, total: 72 },
          { repId: "rep-1", repName: "Avery Rep", calls: 10, emails: 26, meetings: 6, notes: 7, total: 49 },
        ],
        strategicAlerts: [
          {
            id: "pipeline-gap",
            severity: "warning",
            title: "Pipeline gap",
            detail: "$140,000 behind QTD goal.",
          },
          {
            id: "rep-risk",
            severity: "critical",
            title: "At-risk pipeline",
            detail: "Avery Rep has 3 at-risk deals.",
            repId: "rep-1",
          },
        ],
        aiCoachingPrompts: [
          {
            id: "coach-1",
            repId: "rep-1",
            repName: "Avery Rep",
            prompt: "Review Avery Rep's current pipeline and next-step coverage.",
            reason: "At-risk deals are present in the snapshot.",
          },
        ],
        recentCloses: [
          {
            dealId: "deal-closed-1",
            dealNumber: "TR-2001",
            dealName: "Plano Center",
            repId: "rep-2",
            repName: "Blake Rep",
            outcome: "won",
            dealValue: 125000,
            closedAt: "2026-05-08",
          },
        ],
      },
    });
  });

  it("renders director hero with shell actions and QTD time-range active", () => {
    const html = renderPageHtml();

    expect(html).toContain("Director Dashboard");
    expect(html).toContain("Strategic performance overview");
    expect(html).toContain("MTD");
    expect(html).toContain("QTD");
    expect(html).toContain("Last quarter");
    expect(html).toContain("Refresh dashboard");
  });

  it("routes stale deal drilldowns to the reports stale deals section", () => {
    const html = renderPageHtml();

    expect(html).toContain('href="/reports#stale-deals"');
    expect(html).not.toContain('href="/deals?filter=stale"');
  });

  it("renders KPI strip with all expected metrics", () => {
    const html = renderPageHtml();

    expect(html).toContain("Active pipeline");
    expect(html).toContain("Closed QTD");
    expect(html).toContain("At risk");
    expect(html).toContain("Weighted forecast");
    expect(html).toContain("Goal $500,000 QTD");
    expect(html).toContain("$910,000");
  });

  it("renders forecast vs goal with mini metrics and progress bars", () => {
    const html = renderPageHtml();

    expect(html).toContain("Forecast vs goal");
    expect(html).toContain("$360,000 / $500,000");
    expect(html).toContain("Pace");
    expect(html).toContain("Closing");
    expect(html).toContain("Activity");
    expect(html).toContain("Won");
    expect(html).toContain("Pipe");
  });

  it("renders sales force performance table with spec columns and rep links", () => {
    const html = renderPageHtml();

    expect(html).toContain("Sales Force Performance");
    expect(html).toContain("Click rep for full breakdown");
    expect(html).toContain("Export");
    expect(html).toContain("Distribution");
    expect(html).toContain("North DFW");
    expect(html).toContain('href="/director/rep/rep-1"');
    expect(html).toContain('href="/director/rep/rep-2"');
  });

  it("renders strategic alerts and AI coaching panels from real hook data", () => {
    const html = renderPageHtml();

    expect(html).toContain("Strategic Alerts");
    expect(html).toContain("Pipeline gap");
    expect(html).toContain("At-risk pipeline");
    expect(html).toContain("AI Coaching");
    expect(html).toContain("Review Avery Rep");
    expect(html).toContain("Schedule 1:1");
  });

  it("renders at-risk deals table with deal detail links and SLA context", () => {
    const html = renderPageHtml();

    expect(html).toContain("At-risk deals");
    expect(html).toContain("Open all");
    expect(html).toContain("Dallas ISD Roof");
    expect(html).toContain("8 days over SLA");
    expect(html).toContain('href="/deals/deal-1"');
  });

  it("time-range change triggers data refresh", async () => {
    const { container, cleanup } = await renderPageDom();

    try {
      expect(mocks.useDirectorDashboardMock).toHaveBeenLastCalledWith({
        from: "2026-qtd-from",
        to: "2026-qtd-to",
      });

      await act(async () => {
        container.querySelector<HTMLButtonElement>("[data-testid='preset-mtd']")?.click();
      });

      expect(mocks.useDirectorDashboardMock).toHaveBeenLastCalledWith({
        from: "2026-mtd-from",
        to: "2026-mtd-to",
      });
    } finally {
      await cleanup();
    }
  });

  it("renders activity pulse and recent closes panels", () => {
    const html = renderPageHtml();

    expect(html).toContain("Activity pulse · this week");
    expect(html).toContain("121 total");
    expect(html).toContain("Blake Rep");
    expect(html).toContain("Recent closes");
    expect(html).toContain("1 won · 0 lost");
    expect(html).toContain("Plano Center");
  });
});
