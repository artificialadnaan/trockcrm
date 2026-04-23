import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";
import { DirectorDashboardPage } from "./director-dashboard-page";

const mocks = vi.hoisted(() => ({
  useDirectorDashboardMock: vi.fn(),
  useRepPerformanceMock: vi.fn(),
  usePipelineBoardStateMock: vi.fn(),
  useDealBoardMock: vi.fn(),
  useLeadBoardMock: vi.fn(),
}));

vi.mock("@/hooks/use-director-dashboard", () => ({
  useDirectorDashboard: mocks.useDirectorDashboardMock,
  presetToDateRange: () => ({ from: "2026-01-01", to: "2026-12-31" }),
}));
vi.mock("@/hooks/use-rep-performance", () => ({
  useRepPerformance: mocks.useRepPerformanceMock,
}));
vi.mock("@/hooks/use-pipeline-board-state", () => ({ usePipelineBoardState: mocks.usePipelineBoardStateMock }));
vi.mock("@/hooks/use-deals", () => ({ useDealBoard: mocks.useDealBoardMock }));
vi.mock("@/hooks/use-leads", () => ({ useLeadBoard: mocks.useLeadBoardMock }));
vi.mock("@/lib/pipeline-ownership", () => ({
  getWorkflowRouteLabel: (route: "normal" | "service") => (route === "service" ? "Service" : "Standard"),
}));
vi.mock("@/components/dashboard/director-dashboard-shell", () => ({
  DirectorDashboardShell: ({ boardEntity, loading, error }: { boardEntity: "deals" | "leads"; loading: boolean; error: string | null }) => (
    <div>
      <h2>Team Pipeline Console</h2>
      <div aria-pressed={boardEntity === "leads"}>Leads</div>
      <div>{loading ? "Board loading" : "Board ready"}</div>
      {error ? <div>{error}</div> : null}
    </div>
  ),
}));
vi.mock("@/components/ai/director-blind-spot-list", () => ({
  DirectorBlindSpotList: () => <div>Blind spots</div>,
}));
vi.mock("@/components/charts/pipeline-bar-chart", () => ({
  PipelineBarChart: () => <div>Pipeline chart</div>,
}));
vi.mock("@/components/charts/win-rate-trend-chart", () => ({
  WinRateTrendChart: () => <div>Win rate chart</div>,
}));
vi.mock("@/components/charts/chart-colors", () => ({
  formatCurrency: (value: number) => `$${value.toLocaleString()}`,
}));
vi.mock("@/components/dashboard/dashboard-kpi-band", () => ({
  DashboardKpiBand: ({ items }: { items: Array<{ label: string }> }) => <div>{items.map((item) => item.label).join(", ")}</div>,
}));
vi.mock("@/components/dashboard/funnel-bucket-row", () => ({
  FunnelBucketRow: ({ buckets }: { buckets: Array<{ label: string }> }) => <div>{buckets.map((bucket) => bucket.label).join(", ")}</div>,
}));
vi.mock("@/components/dashboard/director-funnel-table", () => ({
  DirectorFunnelTable: () => <div>Funnel table</div>,
}));
vi.mock("@/components/dashboard/director-activity-summary", () => ({
  DirectorActivitySummary: () => <div>Activity summary</div>,
}));
vi.mock("@/components/dashboard/director-alert-panel", () => ({
  DirectorAlertPanel: () => <div>Alert panel</div>,
}));
vi.mock("@/components/dashboard/director-rep-workspace", () => ({
  DirectorRepWorkspace: ({ repCards }: { repCards: Array<{ repName: string }> }) => <div>{repCards.map((rep) => rep.repName).join(", ")}</div>,
}));
vi.mock("@/lib/director-dashboard-actions", () => ({
  DIRECTOR_DASHBOARD_ACTIONS: [
    { key: "reports", label: "Reports", title: "Open reports", to: "/reports" },
    { key: "alerts", label: "Alerts", title: "Open alerts", to: "/alerts" },
  ],
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

describe("DirectorDashboardPage", () => {
  beforeEach(() => {
    mocks.usePipelineBoardStateMock.mockReturnValue({
      activeEntity: "leads",
      setActiveEntity: vi.fn(),
    });
    mocks.useDirectorDashboardMock.mockReturnValue({
      loading: false,
      error: null,
      data: {
        officeFunnelBuckets: [
          { key: "lead", label: "Leads", count: 4, totalValue: null, route: "/leads", bucket: "lead" },
        ],
        repFunnelRows: [],
        repCommissionRows: [],
        repCards: [{ repId: "rep-1", repName: "Alex Rep", activeDeals: 2, pipelineValue: 500000, winRate: 45, activityScore: 80, staleDeals: 1, staleLeads: 0 }],
        pipelineByStage: [],
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
        ddVsPipeline: { ddValue: 100000, ddCount: 2, pipelineValue: 500000, pipelineCount: 8, totalValue: 600000, totalCount: 10 },
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
      },
    });
    mocks.useRepPerformanceMock.mockReturnValue({
      loading: false,
      data: {
        periodLabel: { current: "This month", previous: "Last month" },
        reps: [],
      },
    });
    mocks.useDealBoardMock.mockReturnValue({ board: { columns: [] }, loading: false, error: null });
    mocks.useLeadBoardMock.mockReturnValue({ board: { columns: [], defaultConversionDealStageId: null }, loading: false, error: null });
  });

  it("keeps the board console while restoring the director workspace sections", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <DirectorDashboardPage />
      </MemoryRouter>
    );

    expect(html).toContain("Team Pipeline Console");
    expect(html).toContain("Director Dashboard");
    expect(html).toContain("Funnel distribution by rep");
    expect(html).toContain("Performance trends");
    expect(html).toContain("Reports");
  });

  it("keeps the team board shell visible while summary analytics are still loading", () => {
    mocks.useDirectorDashboardMock.mockReturnValue({
      loading: true,
      error: null,
      data: null,
    });

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <DirectorDashboardPage />
      </MemoryRouter>
    );

    expect(html).toContain("Team Pipeline Console");
    expect(html).toContain("aria-label=\"Primary workspace\"");
  });
});
