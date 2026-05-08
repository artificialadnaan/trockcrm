import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { RepDashboardPage } from "./rep-dashboard-page";

const mocks = vi.hoisted(() => ({
  useRepDashboardMock: vi.fn(),
  usePipelineBoardStateMock: vi.fn(),
  useDealBoardMock: vi.fn(),
  useLeadBoardMock: vi.fn(),
  usePipelineStagesMock: vi.fn(),
}));

vi.mock("@/hooks/use-dashboard", () => ({ useRepDashboard: mocks.useRepDashboardMock }));
vi.mock("@/hooks/use-pipeline-board-state", () => ({ usePipelineBoardState: mocks.usePipelineBoardStateMock }));
vi.mock("@/hooks/use-deals", () => ({
  useDealBoard: mocks.useDealBoardMock,
  changeDealStage: vi.fn(),
}));
vi.mock("@/hooks/use-leads", () => ({
  useLeadBoard: mocks.useLeadBoardMock,
  transitionLeadStage: vi.fn(),
}));
vi.mock("@/hooks/use-pipeline-config", () => ({ usePipelineStages: mocks.usePipelineStagesMock }));
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: { displayName: "Alex Rep" },
  }),
}));
vi.mock("@/hooks/use-tasks", () => ({
  useTasks: () => ({
    tasks: [],
    refetch: vi.fn(),
  }),
}));
vi.mock("@/lib/pipeline-ownership", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pipeline-ownership")>();
  return {
    ...actual,
    getWorkflowRouteLabel: (route: "normal" | "service") => (route === "service" ? "Service" : "Standard"),
  };
});
vi.mock("@/components/dashboard/rep-dashboard-board-shell", () => ({
  RepDashboardBoardShell: () => <div>My Board</div>,
}));
vi.mock("@/components/layout/page-header", () => ({
  PageHeader: ({ title, description }: { title: string; description?: string }) => (
    <div>
      <h1>{title}</h1>
      {description ? <p>{description}</p> : null}
    </div>
  ),
}));
vi.mock("@/components/charts/pipeline-bar-chart", () => ({
  PipelineBarChart: () => <div>Pipeline chart</div>,
}));
vi.mock("@/components/charts/chart-colors", () => ({
  formatCurrency: (value: number) => `$${value.toLocaleString()}`,
}));
vi.mock("@/components/tasks/task-section", () => ({
  TaskSection: ({ title }: { title: string }) => <div>{title}</div>,
}));
vi.mock("@/components/dashboard/funnel-bucket-row", () => ({
  FunnelBucketRow: ({ buckets }: { buckets: Array<{ label: string }> }) => (
    <div>{buckets.map((bucket) => bucket.label).join(", ")}</div>
  ),
}));
vi.mock("@/components/ui/card", () => ({
  Card: ({ children, className }: { children: ReactNode; className?: string }) => <div className={className}>{children}</div>,
  CardContent: ({ children, className }: { children: ReactNode; className?: string }) => <div className={className}>{children}</div>,
  CardHeader: ({ children, className }: { children: ReactNode; className?: string }) => <div className={className}>{children}</div>,
  CardTitle: ({ children, className }: { children: ReactNode; className?: string }) => <div className={className}>{children}</div>,
}));
vi.mock("@/components/ui/button", () => ({
  buttonVariants: vi.fn(({ variant, size, className }: { variant?: string; size?: string; className?: string } = {}) =>
    ["mock-button", variant, size, className].filter(Boolean).join(" ")
  ),
  Button: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => <button onClick={onClick}>{children}</button>,
}));
vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children, className }: { children: ReactNode; className?: string }) => <span className={className}>{children}</span>,
}));

const dashboardData = {
  activeLeads: { count: 4 },
  funnelBuckets: [
    { key: "lead", label: "Leads", count: 4, totalValue: null, route: "/leads", bucket: "lead" },
    { key: "qualified_lead", label: "Qualified Leads", count: 2, totalValue: null, route: "/leads", bucket: "qualified_lead" },
    { key: "opportunity", label: "Opportunities", count: 3, totalValue: 450000, route: "/leads", bucket: "opportunity" },
    { key: "estimating", label: "Bid Board Pipeline", count: 6, totalValue: 300000, route: "/deals", bucket: "estimating" },
  ],
  commissionSummary: {
    commissionRate: 0.08,
    overrideRate: 0.02,
    rollingFloor: 100000,
    rollingPaidRevenue: 25000,
    rollingCommissionableMargin: 5000,
    floorRemaining: 75000,
    newCustomerRevenue: 20000,
    newCustomerShare: 0.2,
    newCustomerShareFloor: 0.1,
    meetsNewCustomerShare: true,
    estimatedPaymentCount: 2,
    excludedLowMarginRevenue: 0,
    directEarnedCommission: 31200,
    overrideEarnedCommission: 150,
    totalEarnedCommission: 38400,
    potentialRevenue: 50000,
    potentialMargin: 15000,
    potentialCommission: 1200,
  },
  activeDeals: { count: 6, totalValue: 300000 },
  contractsSignedYtd: { count: 0, totalValue: 0 },
  contractsSignedMtd: { count: 0, totalValue: 0 },
  tasksToday: { overdue: 3, today: 2 },
  activityThisWeek: { calls: 1, emails: 2, meetings: 3, notes: 4, total: 10 },
  followUpCompliance: { total: 5, onTime: 3, complianceRate: 60 },
  pipelineByStage: [],
  staleLeads: {
    count: 1,
    averageDaysInStage: 16,
    leads: [{
      leadId: "lead-1",
      leadName: "Lead One",
      companyName: "Acme",
      propertyName: "North Plaza",
      stageName: "Qualified Lead",
      daysInStage: 16,
      updatedAt: new Date("2026-04-20T12:00:00Z").toISOString(),
      pipelineType: "normal",
      locationLabel: "Austin, TX",
      estimatedValue: 92000,
      staleThresholdDays: 14,
    }],
  },
  leadSnapshot: [
    {
      leadId: "lead-1",
      leadName: "Lead One",
      companyName: "Acme",
      propertyName: "North Plaza",
      stageName: "Contacted",
      daysInStage: 3,
      updatedAt: new Date("2026-04-20T12:00:00Z").toISOString(),
    },
  ],
  dealSnapshot: [
    {
      dealId: "deal-1",
      dealName: "Deal One",
      companyName: "Acme",
      propertyName: "North Plaza",
      stageName: "Estimating",
      totalValue: 300000,
      updatedAt: new Date("2026-04-20T12:00:00Z").toISOString(),
    },
  ],
  myCleanup: {
    total: 4,
    byReason: [
      { reasonCode: "missing_owner", count: 2 },
      { reasonCode: "stale_no_recent_activity", count: 1 },
    ],
  },
  crmOwnedProgression: [
    { workflowBucket: "lead", workflowRoute: "normal", stageName: "Qualified Lead", itemCount: 2, totalValue: 125000 },
    { workflowBucket: "opportunity", workflowRoute: "service", stageName: "Opportunity", itemCount: 3, totalValue: 450000 },
  ],
  downstreamBottlenecks: [
    {
      dealId: "deal-1",
      dealName: "Dallas ISD Roof",
      stageName: "Service - Estimating",
      mirroredStageStatus: "blocked",
      workflowRoute: "service",
      regionClassification: "Dallas, TX",
      dealValue: 275000,
      daysInStage: 22,
      staleThresholdDays: 14,
    },
  ],
};

function renderDashboard() {
  return renderToStaticMarkup(
    <MemoryRouter>
      <RepDashboardPage />
    </MemoryRouter>
  );
}

describe("RepDashboardPage", () => {
  beforeEach(() => {
    mocks.usePipelineBoardStateMock.mockReturnValue({
      activeEntity: "leads",
      setActiveEntity: vi.fn(),
    });
    mocks.usePipelineStagesMock.mockReturnValue({ stages: [] });
    mocks.useRepDashboardMock.mockReturnValue({
      loading: false,
      error: null,
      data: dashboardData,
      fetchedAt: new Date("2026-05-08T17:00:00Z"),
      refetch: vi.fn(),
    });
    mocks.useDealBoardMock.mockReturnValue({ board: { columns: [] }, loading: false, error: null, refetch: vi.fn() });
    mocks.useLeadBoardMock.mockReturnValue({ board: { columns: [], defaultConversionDealStageId: null }, loading: false, error: null, refetch: vi.fn() });
  });

  it("renders WELCOME hero with first name uppercase", () => {
    const html = renderDashboard();

    expect(html).toContain("WELCOME, ALEX");
    expect(html).toContain("TODAY&#x27;S WORK");
  });

  it("renders 3 KPI cards: active deals, active leads, commission YTD", () => {
    const html = renderDashboard();

    expect(html).toContain("ACTIVE DEALS");
    expect(html).toContain("ACTIVE LEADS");
    expect(html).toContain("COMMISSION YTD");
    expect(html).toContain("6 DEALS");
    expect(html).toContain("2 QUALIFIED");
  });

  it("renders top deals table with stage badges and values", () => {
    const html = renderDashboard();

    expect(html).toContain("TOP DEALS");
    expect(html).toContain("Dallas ISD Roof");
    expect(html).toContain("SERVICE - ESTIMATING");
    expect(html).toContain("$275,000");
  });

  it("renders strategic alerts panel", () => {
    const html = renderDashboard();

    expect(html).toContain("STRATEGIC ALERTS");
    expect(html).toContain("3 overdue tasks");
    expect(html).toContain("Follow-up compliance below 80%");
  });

  it("renders AI blind spots panel", () => {
    const html = renderDashboard();

    expect(html).toContain("AI BLIND SPOTS");
    expect(html).toContain("Dallas ISD Roof");
    expect(html).toContain("Service stage is past SLA");
    expect(html).toContain("Lead One");
  });

  it("renders 4 KPI tiles: leads, qualified, opportunities, bid board", () => {
    const html = renderDashboard();

    expect(html).toContain("LEADS");
    expect(html).toContain("QUALIFIED");
    expect(html).toContain("OPPORTUNITIES");
    expect(html).toContain("BID BOARD");
  });

  it("renders MY NUMBERS section with 8 metric cells", () => {
    const html = renderDashboard();

    expect(html).toContain("MY NUMBERS");
    expect(html).toContain("CLEANUP");
    expect(html).toContain("STALE LEADS");
    expect(html).toContain("FOLLOW-UP");
    expect(html).toContain("OVERDUE");
    expect(html).toContain("CALLS");
    expect(html).toContain("EMAILS");
    expect(html).toContain("MEETINGS");
    expect(html).toContain("NOTES");
  });

  it("renders bottom action bar with Performance report and Open my pipeline", () => {
    const html = renderDashboard();

    expect(html).toContain("Performance report");
    expect(html).toContain("Open my pipeline");
    expect(html).toContain("href=\"/reports/performance\"");
    expect(html).toContain("href=\"/deals\"");
  });

  it("TimeRangeTabs default to YTD", () => {
    const html = renderDashboard();

    expect(html).toContain("aria-pressed=\"true\"");
    expect(html).toContain(">YTD</button>");
  });

  it("Open my pipeline button uses link semantics and the dashboard omits the old board shell", () => {
    const html = renderDashboard();

    expect(html).toContain("<a");
    expect(html).toContain("href=\"/deals\"");
    expect(html).not.toContain("My Board");
  });
});
