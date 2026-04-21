import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";

const mocks = vi.hoisted(() => ({
  useRepDashboardMock: vi.fn(),
  usePipelineBoardStateMock: vi.fn(),
  useDealBoardMock: vi.fn(),
  useLeadBoardMock: vi.fn(),
}));

vi.mock("@/hooks/use-dashboard", () => ({ useRepDashboard: mocks.useRepDashboardMock }));
vi.mock("@/hooks/use-pipeline-board-state", () => ({ usePipelineBoardState: mocks.usePipelineBoardStateMock }));
vi.mock("@/hooks/use-deals", () => ({ useDealBoard: mocks.useDealBoardMock }));
vi.mock("@/hooks/use-leads", () => ({ useLeadBoard: mocks.useLeadBoardMock }));
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
vi.mock("@/components/dashboard/rep-dashboard-board-shell", () => ({
  RepDashboardBoardShell: ({ activeEntity, loading, error }: { activeEntity: "deals" | "leads"; loading: boolean; error: string | null }) => (
    <div>
      <h1>My Board</h1>
      <div aria-pressed={activeEntity === "leads"}>Leads</div>
      <div>{loading ? "Board loading" : "Board ready"}</div>
      {error ? <div>{error}</div> : null}
    </div>
  ),
}));
vi.mock("@/components/layout/page-header", () => ({
  PageHeader: ({ title, description }: { title: string; description?: string }) => (
    <div>
      <h1>{title}</h1>
      {description ? <p>{description}</p> : null}
    </div>
  ),
}));
vi.mock("@/components/dashboard/stat-card", () => ({
  StatCard: ({ title, value }: { title: string; value: string | number }) => (
    <div data-testid={`stat-${title}`}>{value}</div>
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
vi.mock("@/components/dashboard/my-cleanup-card", () => ({
  MyCleanupCard: ({ total }: { total: number }) => <a href="/pipeline/my-cleanup">{total} records need enrichment</a>,
}));
vi.mock("@/components/ui/card", () => ({
  Card: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({ children }: { children: ReactNode }) => <button>{children}</button>,
}));
vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

import { RepDashboardPage } from "./rep-dashboard-page";

describe("RepDashboardPage", () => {
  beforeEach(() => {
    mocks.usePipelineBoardStateMock.mockReturnValue({
      activeEntity: "leads",
      setActiveEntity: vi.fn(),
    });
    mocks.useRepDashboardMock.mockReturnValue({
      loading: false,
      error: null,
      data: {
        activeLeads: { count: 4 },
        funnelBuckets: [
          { key: "lead", label: "Leads", count: 4, totalValue: null, route: "/leads", bucket: "lead" },
          { key: "qualified_lead", label: "Qualified Leads", count: 2, totalValue: null, route: "/leads", bucket: "qualified_lead" },
          { key: "opportunity", label: "Opportunities", count: 3, totalValue: null, route: "/leads", bucket: "opportunity" },
          { key: "due_diligence", label: "Due Diligence", count: 5, totalValue: 120000, route: "/deals", bucket: "due_diligence" },
          { key: "estimating", label: "Estimating", count: 6, totalValue: 300000, route: "/deals", bucket: "estimating" },
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
          directEarnedCommission: 1000,
          overrideEarnedCommission: 150,
          totalEarnedCommission: 1150,
          potentialRevenue: 50000,
          potentialMargin: 15000,
          potentialCommission: 1200,
        },
        activeDeals: { count: 6, totalValue: 300000 },
        tasksToday: { overdue: 1, today: 2 },
        activityThisWeek: { calls: 1, emails: 2, meetings: 3, notes: 4, total: 10 },
        followUpCompliance: { total: 5, onTime: 4, complianceRate: 80 },
        pipelineByStage: [],
        staleLeads: { count: 0, averageDaysInStage: null, leads: [] },
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
            { reasonCode: "missing_next_step", count: 3 },
            { reasonCode: "stale_no_recent_activity", count: 1 },
          ],
        },
      },
    });
    mocks.useDealBoardMock.mockReturnValue({ board: { columns: [] }, loading: false, error: null });
    mocks.useLeadBoardMock.mockReturnValue({ board: { columns: [], defaultConversionDealStageId: null }, loading: false, error: null });
  });

  it("keeps the board workspace while restoring the richer cockpit sections", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <RepDashboardPage />
      </MemoryRouter>
    );

    expect(html).toContain("My Board");
    expect(html).toContain("4 records need enrichment");
    expect(html).toContain("Today&#x27;s Tasks");
    expect(html).toContain("Qualified Leads");
    expect(html).toContain("Leads Snapshot");
    expect(html).toContain("Deals Snapshot");
    expect(html).toContain('href="/pipeline/my-cleanup"');
  });
});
