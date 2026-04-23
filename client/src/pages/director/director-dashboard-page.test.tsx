import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";
import { DirectorDashboardPage } from "./director-dashboard-page";

const mocks = vi.hoisted(() => ({
  useDirectorDashboardMock: vi.fn(),
  useRepPerformanceMock: vi.fn(),
}));

vi.mock("@/hooks/use-director-dashboard", () => ({
  useDirectorDashboard: mocks.useDirectorDashboardMock,
  presetToDateRange: () => ({ from: "2026-01-01", to: "2026-12-31" }),
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

describe("DirectorDashboardPage", () => {
  beforeEach(() => {
    mocks.useRepPerformanceMock.mockReturnValue({
      data: { reps: [], periodLabel: { current: "Current", previous: "Previous" } },
      loading: false,
    });
    mocks.useDirectorDashboardMock.mockReturnValue({
      loading: false,
      error: null,
      data: {
        repCards: [{
          repId: "rep-1",
          repName: "Avery Rep",
          activeDeals: 6,
          pipelineValue: 910000,
          winRate: 67,
          activityScore: 49,
          staleDeals: 1,
          staleLeads: 2,
        }],
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
      },
    });
  });

  it("renders CRM-owned and mirrored downstream review panels with service path and bottleneck context", () => {
    const html = normalize(
      renderToStaticMarkup(
        <MemoryRouter>
          <DirectorDashboardPage />
        </MemoryRouter>
      )
    );

    expect(html).toContain("CRM-Owned Progression");
    expect(html).toContain("Qualified Lead");
    expect(html).toContain("Service path");
    expect(html).toContain("Bid Board Bottlenecks");
    expect(html).toContain("Dallas ISD Roof");
    expect(html).toContain("blocked");
    expect(html).toContain("Dallas, TX");
    expect(html).toContain("$275,000");
    expect(html).toContain("22d / 14d target");
  });
});
