// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  dashboardRefetchMock: vi.fn(),
  performanceRefetchMock: vi.fn(),
  useAuthMock: vi.fn(),
}));

vi.mock("@/hooks/use-director-dashboard", () => ({
  useDirectorDashboard: mocks.useDirectorDashboardMock,
  presetToDateRange: mocks.presetToDateRangeMock,
}));

vi.mock("@/hooks/use-rep-performance", () => ({
  useRepPerformance: mocks.useRepPerformanceMock,
}));

vi.mock("@/lib/auth", () => ({
  useAuth: mocks.useAuthMock,
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

function renderPageHtml(initialEntry = "/?scope=all") {
  return normalize(
    renderToStaticMarkup(
      <MemoryRouter initialEntries={[initialEntry]}>
        <DirectorDashboardPage />
      </MemoryRouter>
    )
  );
}

async function renderPageDom(initialEntry = "/?scope=all") {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <MemoryRouter initialEntries={[initialEntry]}>
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
    vi.useFakeTimers();
    document.body.innerHTML = "";
    vi.clearAllMocks();
    vi.setSystemTime(new Date("2026-05-08T12:00:00Z"));
    mocks.presetToDateRangeMock.mockImplementation((preset: string) => ({
      from: preset === "qtd" ? "2026-04-01" : `2026-${preset}-from`,
      to: preset === "qtd" ? "2026-05-08" : `2026-${preset}-to`,
    }));
    mocks.useAuthMock.mockReturnValue({
      user: {
        id: "director-1",
        role: "director",
      },
    });
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
      error: null,
      refetch: mocks.performanceRefetchMock,
    });
    mocks.useDirectorDashboardMock.mockReturnValue({
      loading: false,
      error: null,
      refetch: mocks.dashboardRefetchMock,
      lastFetchedAt: "2026-05-08T11:57:00Z",
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
            closedValue: 240000,
            winsCount: 4,
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
            closedValue: 120000,
            winsCount: 2,
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
        scopeSummary: {
          activePipeline: { count: 4, totalValue: 610000 },
          // Won card aggregate == the canonical per-rep closed sum (rep-1 $240k/4 +
          // rep-2 $120k/2). The page-level Closed total reads this authoritative value.
          won: { count: 6, totalValue: 360000 },
          atRisk: { count: 1, totalValue: 275000 },
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
          repId: "rep-1",
          repName: "Avery Rep",
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

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders director hero with shell actions and QTD time-range active", () => {
    const html = renderPageHtml();

    expect(html).toContain("Director Dashboard");
    expect(html).toContain("Strategic performance overview");
    expect(html).toContain("synced 3m ago");
    expect(html).toContain("MTD");
    expect(html).toContain("QTD");
    expect(html).toContain("Last quarter");
    expect(html).toContain("Refresh dashboard");
  });

  it("surfaces notes in the activity pulse so the bar reflects the full total", () => {
    const html = renderPageHtml();

    // activityPulse rows carry notes (Blake/Avery have notes: 7). The bar segments
    // and labels must include notes, not just calls/emails/meetings, or a rep whose
    // activity is mostly notes shows an under-filled bar with the count hidden.
    expect(html).toContain("7 notes");
  });

  it("routes at-risk deal drilldowns to the filtered deals list", () => {
    const html = renderPageHtml();

    expect(html).toContain('href="/deals?filter=at_risk&amp;scope=all"');
    expect(html).not.toContain('href="/deals?filter=at_risk&amp;period=qtd&amp;scope=all"');
    expect(html).not.toContain('href="/reports?range=qtd#stale-deals"');
  });

  it("renders KPI strip with all expected metrics", () => {
    const html = renderPageHtml();

    expect(html).toContain("Active pipeline");
    expect(html).toContain("Closed QTD");
    expect(html).toContain("At risk");
    expect(html).toContain("Weighted forecast");
    expect(html).toContain("Goal $8,250,000 QTD");
    expect(html).toContain("$910,000");
  });

  it("renders a deal-owning director row with populated stats when the API includes it", () => {
    mocks.useRepPerformanceMock.mockReturnValue({
      ...mocks.useRepPerformanceMock(),
      data: {
        ...mocks.useRepPerformanceMock().data,
        reps: [
          ...mocks.useRepPerformanceMock().data.reps,
          {
            repId: "director-1",
            repName: "Brett Bell",
            current: {
              dealsWon: 1,
              dealsLost: 0,
              totalWonValue: 31071,
              activitiesLogged: 9,
              winRate: 100,
              avgDaysToClose: 12,
            },
            previous: null,
            change: {
              dealsWon: 0,
              dealsLost: null,
              totalWonValue: 0,
              activitiesLogged: 0,
              winRate: 0,
              avgDaysToClose: 0,
            },
            percentChange: {
              dealsWon: 0,
              dealsLost: null,
              totalWonValue: 0,
              activitiesLogged: 0,
              winRate: 0,
              avgDaysToClose: 0,
            },
          },
        ],
        rows: [
          ...mocks.useRepPerformanceMock().data.rows,
          {
            repId: "director-1",
            repName: "Brett Bell",
            periodKind: "qtd",
            periodStart: "2026-04-01",
            periodEnd: "2026-06-30",
            pipelineValue: 180000,
            closedValue: 31071,
            dealsCount: 3,
            winsCount: 1,
            lossesCount: 0,
            winRate: 100,
            avgDaysToClose: 12,
            atRiskCount: 0,
            activityTotal: 9,
            calls: 2,
            emails: 5,
            meetings: 1,
            notes: 1,
            sparkline8w: [0, 0, 0, 1, 1, 1, 1, 1],
            region: "Dallas Office",
            computedAt: "2026-05-08T12:00:00Z",
            forecast: 180000,
            goal: 500000,
            goalSource: "manual",
            percentToGoal: 36,
            forecastVsGoal: {
              forecast: 180000,
              goal: 500000,
              goalSource: "manual",
              percentToGoal: 36,
            },
            previous: null,
          },
        ],
      },
    });

    mocks.useDirectorDashboardMock.mockReturnValue({
      ...mocks.useDirectorDashboardMock(),
      data: {
        ...mocks.useDirectorDashboardMock().data,
        repFunnelRows: [
          ...mocks.useDirectorDashboardMock().data.repFunnelRows,
          { repId: "director-1", repName: "Brett Bell", leads: 0, qualifiedLeads: 0, opportunities: 0, estimating: 3 },
        ],
        repCards: [
          ...mocks.useDirectorDashboardMock().data.repCards,
          {
            repId: "director-1",
            repName: "Brett Bell",
            activeDeals: 3,
            pipelineValue: 180000,
            winRate: 100,
            activityScore: 9,
            staleDeals: 0,
            staleLeads: 0,
            closedValue: 31071,
            winsCount: 1,
          },
        ],
      },
    });

    const html = renderPageHtml();

    expect(html).toContain("Brett Bell");
    expect(html).toContain("$31,071");
    expect(html).toContain("$180,000");
    expect(html).toContain("Dallas Office");
  });

  it("links the summary cards and drill-down badges to their filtered destinations", () => {
    const html = renderPageHtml();

    expect(html).toContain('href="/deals?filter=active_pipeline&amp;period=qtd&amp;scope=all"');
    expect(html).toContain('href="/deals?filter=won&amp;period=qtd&amp;scope=all"');
    expect(html).toContain('href="/deals?filter=at_risk&amp;scope=all"');
    expect(html).toContain('href="/reports/performance/forecast-accuracy?range=qtd"');
    expect(html).toContain('href="/reports/performance/rep-activity?range=qtd"');
  });

  it("routes the Closing KPI to closed won deals for the active period", () => {
    const html = renderPageHtml();

    expect(html).toContain("Closing");
    expect(html).toContain("1 this quarter");
    expect(html).toContain('aria-label="View recent closed deals"');
    expect(html).toContain('href="/deals?filter=won&amp;period=qtd&amp;scope=all"');
  });

  it("hides the Team scope and coerces a manual ?scope=team URL to a real scope", () => {
    const html = renderPageHtml("/?scope=team");

    // Team is no longer an offered scope: no Team toggle button, no dead placeholder.
    expect(html).not.toContain(">Team</button>");
    expect(html).not.toContain("Team view is not yet configured.");
    // A manual ?scope=team URL coerces to the fallback ("mine"), never requests "team".
    expect(mocks.useDirectorDashboardMock).toHaveBeenCalledWith(
      { from: "2026-04-01", to: "2026-05-08" },
      "qtd",
      "mine"
    );
  });

  it("preserves the selected dashboard period in drill-down links", async () => {
    const { container, cleanup } = await renderPageDom();
    try {
      const ytdPreset = Array.from(container.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("YTD")
      );
      expect(ytdPreset).not.toBeNull();

      await act(async () => {
        ytdPreset?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      const activeLink = Array.from(container.querySelectorAll("a")).find((link) =>
        link.getAttribute("aria-label")?.includes("View active pipeline deals")
      );
      const activityLink = Array.from(container.querySelectorAll("a")).find((link) =>
        link.getAttribute("aria-label")?.includes("View activity report")
      );

      expect(activeLink?.getAttribute("href")).toBe("/deals?filter=active_pipeline&period=ytd&scope=all");
      expect(activityLink?.getAttribute("href")).toBe("/reports/performance/rep-activity?range=ytd");
    } finally {
      await cleanup();
    }
  });

  it("renders forecast vs goal with mini metrics and progress bars", () => {
    const html = renderPageHtml();

    expect(html).toContain("Forecast vs goal");
    expect(html).toContain("$360,000 / $8,250,000");
    expect(html).toContain("8 weeks remaining");
    expect(html).toContain("Pace");
    expect(html).toContain("Closing");
    expect(html).toContain("1 this quarter");
    expect(html).toContain("121 this quarter");
    expect(html).toContain("Won");
    expect(html).toContain("Pipe");
  });

  it("surfaces the prorated target-to-date next to the pace so the gap is visible", () => {
    const html = renderPageHtml();

    // Default render is QTD on 2026-05-08 (day 38 of a 91-day quarter): the $8.25M
    // quarterly target prorated to date is 8_250_000 * 38/91 = $3,445,055, shown next
    // to the current Closed ($360,000 from scopeSummary.won) so the gap is explicit.
    expect(html).toContain("Target to date $3,445,055");
    expect(html).toContain("at $360,000");
  });

  it("uses the hard-coded revenue goal (real comparison) even when the payload goal is null", () => {
    // The goal is now a hard-coded constant (no goal store yet), so a null payload goal no
    // longer yields a "No goal set" honest state -- the block shows the period's real target
    // and a coherent pace derived from Closed vs the day-prorated expected-to-date.
    mocks.useDirectorDashboardMock.mockReturnValue({
      ...mocks.useDirectorDashboardMock(),
      data: {
        ...mocks.useDirectorDashboardMock().data,
        forecastVsGoal: { forecast: 610000, goal: null, goalSource: "none", percentToGoal: null },
      },
    });

    const html = renderPageHtml();

    // Default render is QTD -> quarterly target $8,250,000; the honest no-goal copy is gone.
    expect(html).toContain("$8,250,000");
    expect(html).not.toContain("No goal set");
    expect(html).not.toContain("Goal not configured");
    // Closed ($360k from scopeSummary.won) is far below the QTD prorated pace -> Behind.
    expect(html).toContain("Behind pace");
  });

  it("does not caption the personal Closed card against the company goal in Mine scope", () => {
    // In Mine scope the Closed value is the viewer's own (scopeSummary.won is viewer-scoped)
    // and the forecast/goal section is hidden, so the company period goal must NOT label it.
    const mineHtml = renderPageHtml("/?scope=mine");
    expect(mineHtml).not.toContain("Goal $8,250,000");
    expect(mineHtml).toContain("Your closed revenue");

    // All scope still shows the company goal on the Closed card caption.
    const allHtml = renderPageHtml("/?scope=all");
    expect(allHtml).toContain("Goal $8,250,000 QTD");
  });

  it("surfaces an Unassigned row so the Sales Force Closed column sums to the Closed card", () => {
    // The Closed card (scopeSummary.won) exceeds the sum of per-rep closed (240k + 120k =
    // 360k) by $50,000 / 2 wins -> the remainder must appear as an Unassigned row so the
    // table reconciles to the card by construction (Codex P2 / P2-8 reconciliation).
    mocks.useDirectorDashboardMock.mockReturnValue({
      ...mocks.useDirectorDashboardMock(),
      data: {
        ...mocks.useDirectorDashboardMock().data,
        scopeSummary: {
          ...mocks.useDirectorDashboardMock().data.scopeSummary,
          won: { count: 8, totalValue: 410000 },
        },
      },
    });

    const html = renderPageHtml();

    expect(html).toContain('data-testid="rep-row-unassigned"');
    expect(html).toContain("Unassigned");
    expect(html).toContain("$50,000");
  });

  it("renders sales force performance table with spec columns and rep links", () => {
    const html = renderPageHtml();

    expect(html).toContain("Sales Force Performance");
    expect(html).toContain("Click rep for full breakdown");
    expect(html).toContain("Export");
    expect(html).toContain("Distribution");
    expect(html).toContain("North DFW");
    expect(html).toContain('href="/director/rep/rep-1?preset=qtd"');
    expect(html).toContain('href="/director/rep/rep-2?preset=qtd"');
  });

  it("renders a mobile card stack alongside the desktop table without a hover-gated breakdown link", () => {
    const html = renderPageHtml();

    // Desktop: the 980px table is preserved but hidden below md.
    expect(html).toContain('data-testid="director-leaderboard"');
    expect(html).toContain("min-w-[980px]");
    expect(html).toContain("hidden overflow-x-auto md:block");

    // Mobile: the same reps stacked into cards (shown only below md).
    expect(html).toContain('data-testid="director-leaderboard-cards"');
    expect(html).toContain('data-testid="rep-card-rep-1"');
    // The card breakdown link is always visible on touch (no opacity-0 hover gate).
    const cardLinkIndex = html.indexOf('data-testid="rep-card-link-rep-1"');
    expect(cardLinkIndex).toBeGreaterThan(-1);
    const cardLinkTag = html.slice(html.lastIndexOf("<a", cardLinkIndex), cardLinkIndex);
    expect(cardLinkTag).not.toContain("opacity-0");
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
        from: "2026-04-01",
        to: "2026-05-08",
      }, "qtd", "all");

      await act(async () => {
        container.querySelector<HTMLButtonElement>("[data-testid='preset-mtd']")?.click();
      });

      expect(mocks.useDirectorDashboardMock).toHaveBeenLastCalledWith({
        from: "2026-mtd-from",
        to: "2026-mtd-to",
      }, "mtd", "all");
      expect(mocks.useRepPerformanceMock).toHaveBeenLastCalledWith("mtd");
    } finally {
      await cleanup();
    }
  });

  it("renders activity pulse and recent closes panels", () => {
    const html = renderPageHtml();

    expect(html).toContain("Activity pulse · QTD");
    expect(html).toContain("121 total");
    expect(html).toContain("Blake Rep");
    expect(html).toContain("Recent closes");
    expect(html).toContain("1 won · 0 lost");
    expect(html).toContain("Plano Center");
  });

  it("uses historical period kinds instead of legacy current-period mappings", async () => {
    const { container, cleanup } = await renderPageDom();

    try {
      await act(async () => {
        container.querySelector<HTMLButtonElement>("[data-testid='preset-last_month']")?.click();
      });

      expect(mocks.useDirectorDashboardMock).toHaveBeenLastCalledWith({
        from: "2026-last_month-from",
        to: "2026-last_month-to",
      }, "last_month", "all");
      expect(mocks.useRepPerformanceMock).toHaveBeenLastCalledWith("last_month");
    } finally {
      await cleanup();
    }
  });

  it("reads the live director forecast/closed totals, not the stale rep-performance snapshot", () => {
    // Wave 1 (P1-6): the snapshot (useRepPerformance) is intentionally inflated here; the
    // forecast header must ignore it and read the director payload — canonical Closed card
    // (scopeSummary.won = $360,000) over the dashboard goal ($500,000), never the stale
    // snapshot forecast ($910,000).
    mocks.useRepPerformanceMock.mockReturnValue({
      ...mocks.useRepPerformanceMock(),
      data: {
        ...mocks.useRepPerformanceMock().data,
        forecastVsGoal: { forecast: 910000, goal: 500000, goalSource: "manual", percentToGoal: 182 },
      },
    });

    const html = renderPageHtml();

    expect(html).toContain("$360,000 / $8,250,000");
    expect(html).not.toContain("$910,000 / $8,250,000");
  });

  it("counts fallback at-risk reps from backend rep attribution and routes open-all to deals", () => {
    mocks.useDirectorDashboardMock.mockReturnValue({
      ...mocks.useDirectorDashboardMock(),
      data: {
        ...mocks.useDirectorDashboardMock().data,
        staleDeals: [],
        atRiskDeals: [
          {
            dealId: "risk-1",
            repId: "rep-1",
            repName: "Avery Rep",
            dealName: "Risk One",
            stageName: "Contract",
            mirroredStageStatus: "blocked",
            workflowRoute: "service",
            regionClassification: "Dallas, TX",
            dealValue: 100,
            daysInStage: 15,
            staleThresholdDays: 10,
          },
          {
            dealId: "risk-2",
            repId: "rep-2",
            repName: "Blake Rep",
            dealName: "Risk Two",
            stageName: "Production",
            mirroredStageStatus: "blocked",
            workflowRoute: "normal",
            regionClassification: "Austin, TX",
            dealValue: 200,
            daysInStage: 20,
            staleThresholdDays: 10,
          },
        ],
      },
    });

    const html = renderPageHtml();

    expect(html).toContain("2 flagged deals across 2 reps");
    expect(html).toContain('href="/deals?filter=at_risk&amp;scope=all"');
    expect(html).not.toContain('href="/reports#stale-deals"');
  });

  it("uses engine-backed at-risk deal rows instead of stale snapshot counts in the rep leaderboard", () => {
    mocks.useRepPerformanceMock.mockReturnValue({
      ...mocks.useRepPerformanceMock(),
      data: {
        ...mocks.useRepPerformanceMock().data,
        rows: [
          {
            ...mocks.useRepPerformanceMock().data.rows[0],
            repId: "rep-1",
            atRiskCount: 12,
          },
        ],
      },
    });
    mocks.useDirectorDashboardMock.mockReturnValue({
      ...mocks.useDirectorDashboardMock(),
      data: {
        ...mocks.useDirectorDashboardMock().data,
        atRiskDeals: [
          {
            dealId: "risk-1",
            repId: "rep-1",
            repName: "Avery Rep",
            dealName: "Risk One",
            stageName: "Contract",
            mirroredStageStatus: "blocked",
            workflowRoute: "service",
            regionClassification: "Dallas, TX",
            dealValue: 100,
            daysInStage: 15,
            staleThresholdDays: 10,
          },
        ],
      },
    });

    const html = renderPageHtml();

    expect(html).toContain("Avery Rep");
    expect(html).not.toContain(">12<");
    expect(html).toContain(">1<");
  });

  it("refreshes both dashboard and rep performance data", async () => {
    const { container, cleanup } = await renderPageDom();

    try {
      await act(async () => {
        container.querySelector<HTMLButtonElement>("[aria-label='Refresh dashboard']")?.click();
      });

      expect(mocks.dashboardRefetchMock).toHaveBeenCalledOnce();
      expect(mocks.performanceRefetchMock).toHaveBeenCalledOnce();
    } finally {
      await cleanup();
    }
  });

  it("does not render positive-width distribution segments for zero buckets", () => {
    mocks.useDirectorDashboardMock.mockReturnValue({
      ...mocks.useDirectorDashboardMock(),
      data: {
        ...mocks.useDirectorDashboardMock().data,
        repFunnelRows: [
          { repId: "rep-1", repName: "Avery Rep", leads: 1, qualifiedLeads: 0, opportunities: 99, estimating: 0 },
          { repId: "rep-2", repName: "Blake Rep", leads: 0, qualifiedLeads: 0, opportunities: 0, estimating: 0 },
        ],
      },
    });

    const html = renderPageHtml();

    expect(html).toContain("Leads: 1");
    expect(html).toContain("Opportunity: 99");
    expect(html).toContain("width:1%");
    expect(html).not.toContain("Leads: 0");
    // Sentinel for "a zero funnel bucket rendered a spurious segment". 4% is avoided
    // because the forecast Won/Pipe bars legitimately render width:4% here (Closed vs the
    // quarterly goal); 25% is produced by neither the funnel nor the forecast in this mock.
    expect(html).not.toContain("width:25%");
  });

  it("renders live closed totals (not stale snapshot values) while the rep-performance snapshot is loading or errored", () => {
    const stalePerformanceData = {
      rows: [
        {
          repId: "rep-1",
          repName: "Avery Rep",
          periodKind: "mtd",
          periodStart: "2026-05-01",
          periodEnd: "2026-05-08",
          pipelineValue: 900000,
          closedValue: 777777,
          dealsCount: 9,
          winsCount: 8,
          lossesCount: 1,
          winRate: 99,
          avgDaysToClose: 12,
          atRiskCount: 12,
          activityTotal: 88,
          calls: 44,
          emails: 33,
          meetings: 11,
          notes: 0,
          sparkline8w: [99, 88, 77],
          region: "Stale Region",
          computedAt: "2026-05-07T10:00:00.000Z",
          forecast: 900000,
          goal: 1000000,
          goalSource: "manual",
          percentToGoal: 90,
          forecastVsGoal: {
            forecast: 900000,
            goal: 1000000,
            goalSource: "manual",
            percentToGoal: 90,
          },
          previous: null,
        },
      ],
      forecastVsGoal: {
        forecast: 900000,
        goal: 1000000,
        goalSource: "manual",
        percentToGoal: 90,
      },
      reps: [
        {
          repId: "rep-1",
          repName: "Avery Rep",
          current: {
            dealsWon: 8,
            dealsLost: 1,
            totalWonValue: 777777,
            activitiesLogged: 88,
            winRate: 99,
            avgDaysToClose: 12,
          },
          previous: null,
          change: {
            dealsWon: null,
            dealsLost: null,
            totalWonValue: null,
            activitiesLogged: null,
            winRate: null,
            avgDaysToClose: null,
          },
          percentChange: {
            dealsWon: null,
            dealsLost: null,
            totalWonValue: null,
            activitiesLogged: null,
            winRate: null,
            avgDaysToClose: null,
          },
        },
      ],
      periodLabel: {
        current: "Month to date",
        previous: "Baseline pending",
      },
    };

    mocks.useRepPerformanceMock.mockReturnValue({
      data: stalePerformanceData,
      loading: true,
      error: null,
      refetch: mocks.performanceRefetchMock,
    });

    // Finding D (Wave 1): the live Closed (scopeSummary.won) + dashboard goal come from the
    // director payload, so they render even while the rep-performance snapshot is loading,
    // and the stale snapshot values ($777,777 / 99% / Stale Region / 12) never leak. The
    // forecast block is no longer coupled to the snapshot load state; only snapshot-only
    // columns (region) stay gated.
    const loadingHtml = renderPageHtml();
    expect(loadingHtml).toContain("$360,000 / $8,250,000");
    expect(loadingHtml).toContain("Performance pending");
    expect(loadingHtml).not.toContain("Loading performance metrics");
    expect(loadingHtml).not.toContain("Performance metrics pending");
    expect(loadingHtml).not.toContain("$777,777");
    expect(loadingHtml).not.toContain("Stale Region");
    expect(loadingHtml).not.toContain("99%");
    expect(loadingHtml).not.toContain(">12<");

    mocks.useRepPerformanceMock.mockReturnValue({
      data: stalePerformanceData,
      loading: false,
      error: "Snapshot unavailable",
      refetch: mocks.performanceRefetchMock,
    });

    const errorHtml = renderPageHtml();
    expect(errorHtml).toContain("$360,000 / $8,250,000");
    expect(errorHtml).toContain("Performance pending");
    expect(errorHtml).not.toContain("Loading performance metrics");
    expect(errorHtml).not.toContain("Performance metrics pending");
    expect(errorHtml).not.toContain("$777,777");
    expect(errorHtml).not.toContain("Stale Region");
    expect(errorHtml).not.toContain("99%");
    expect(errorHtml).not.toContain(">12<");
  });

  it("does not export stale rep performance values while performance data is unavailable", async () => {
    mocks.useRepPerformanceMock.mockReturnValue({
      data: {
        rows: [
          {
            repId: "rep-1",
            repName: "Avery Rep",
            periodKind: "mtd",
            periodStart: "2026-05-01",
            periodEnd: "2026-05-08",
            pipelineValue: 900000,
            closedValue: 777777,
            dealsCount: 9,
            winsCount: 8,
            lossesCount: 1,
            winRate: 99,
            avgDaysToClose: 12,
            atRiskCount: 12,
            activityTotal: 88,
            calls: 44,
            emails: 33,
            meetings: 11,
            notes: 0,
            sparkline8w: [99, 88, 77],
            region: "Stale Region",
            computedAt: "2026-05-07T10:00:00.000Z",
            forecast: 900000,
            goal: 1000000,
            goalSource: "manual",
            percentToGoal: 90,
            forecastVsGoal: {
              forecast: 900000,
              goal: 1000000,
              goalSource: "manual",
              percentToGoal: 90,
            },
            previous: null,
          },
        ],
        forecastVsGoal: {
          forecast: 900000,
          goal: 1000000,
          goalSource: "manual",
          percentToGoal: 90,
        },
        reps: [],
        periodLabel: {
          current: "Month to date",
          previous: "Baseline pending",
        },
      },
      loading: true,
      error: null,
      refetch: mocks.performanceRefetchMock,
    });

    const originalCreateObjectUrl = URL.createObjectURL;
    const originalRevokeObjectUrl = URL.revokeObjectURL;
    const createObjectURLMock = vi.fn((value: Blob | MediaSource) => {
      void value;
      return "blob:director-csv";
    });
    Object.defineProperty(URL, "createObjectURL", { value: createObjectURLMock, configurable: true });
    Object.defineProperty(URL, "revokeObjectURL", { value: vi.fn(), configurable: true });
    const originalCreateElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tagName: string) => {
      const element = originalCreateElement(tagName);
      if (tagName.toLowerCase() === "a") {
        vi.spyOn(element, "click").mockImplementation(vi.fn());
      }
      return element;
    });

    const { container, cleanup } = await renderPageDom();

    try {
      await act(async () => {
        container.querySelector<HTMLButtonElement>("[data-testid='export-sales-force-csv']")?.click();
      });

      const csvBlob = createObjectURLMock.mock.calls[0]?.[0] as Blob;
      const csv = await csvBlob.text();
      // Wave 1 (P0-1): the rep-table Closed column now reads the canonical per-rep Won
      // from the director payload (always live), NOT the rep_performance snapshot. So the
      // STALE snapshot values must still never leak (777777 / Stale Region / atRisk 12),
      // but the canonical closed ($240,000 / 4) IS exported even while the snapshot endpoint
      // is unavailable -- it is not stale.
      expect(csv).not.toContain("777777");
      expect(csv).not.toContain("Stale Region");
      expect(csv).not.toContain(",12,");
      expect(csv).toContain("Avery Rep,,240000,4,910000,6,67,1,Moderate");
    } finally {
      await cleanup();
      Object.defineProperty(URL, "createObjectURL", { value: originalCreateObjectUrl, configurable: true });
      Object.defineProperty(URL, "revokeObjectURL", { value: originalRevokeObjectUrl, configurable: true });
    }
  });

  it("exports the sales force table as CSV", async () => {
    const originalCreateObjectUrl = URL.createObjectURL;
    const originalRevokeObjectUrl = URL.revokeObjectURL;
    const createObjectURLMock = vi.fn((value: Blob | MediaSource) => {
      void value;
      return "blob:director-csv";
    });
    const revokeObjectURLMock = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { value: createObjectURLMock, configurable: true });
    Object.defineProperty(URL, "revokeObjectURL", { value: revokeObjectURLMock, configurable: true });
    const clickMock = vi.fn();
    const originalCreateElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tagName: string) => {
      const element = originalCreateElement(tagName);
      if (tagName.toLowerCase() === "a") {
        vi.spyOn(element, "click").mockImplementation(clickMock);
      }
      return element;
    });

    const { container, cleanup } = await renderPageDom();

    try {
      await act(async () => {
        container.querySelector<HTMLButtonElement>("[data-testid='export-sales-force-csv']")?.click();
      });

      expect(createObjectURLMock).toHaveBeenCalledOnce();
      const csvBlob = createObjectURLMock.mock.calls[0]?.[0] as Blob;
      await expect(csvBlob.text()).resolves.toContain("Rep,Region,Closed Value,Closed Deals,Pipeline Value,Active Deals,Win Rate,At Risk,Activity");
      await expect(csvBlob.text()).resolves.toContain("Avery Rep,North DFW,240000,4,910000,6,67,1,Moderate");
      expect(clickMock).toHaveBeenCalledOnce();
      expect(revokeObjectURLMock).toHaveBeenCalledWith("blob:director-csv");
    } finally {
      await cleanup();
      Object.defineProperty(URL, "createObjectURL", { value: originalCreateObjectUrl, configurable: true });
      Object.defineProperty(URL, "revokeObjectURL", { value: originalRevokeObjectUrl, configurable: true });
    }
  });
});
