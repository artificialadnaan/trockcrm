import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import pageSource from "./rep-dashboard-page.tsx?raw";
import { RepDashboardPage } from "./rep-dashboard-page";

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: { displayName: "Alex Rep" },
  }),
}));

vi.mock("@/hooks/use-dashboard", () => ({
  useRepDashboard: () => ({
    data: {
      activeLeads: { count: 4 },
      funnelBuckets: [
        { key: "lead", label: "Leads", count: 4, totalValue: null, route: "/leads", bucket: "lead" },
        {
          key: "qualified_lead",
          label: "Qualified Leads",
          count: 2,
          totalValue: null,
          route: "/leads",
          bucket: "qualified_lead",
        },
        {
          key: "opportunity",
          label: "Opportunities",
          count: 3,
          totalValue: null,
          route: "/leads",
          bucket: "opportunity",
        },
        {
          key: "due_diligence",
          label: "Due Diligence",
          count: 5,
          totalValue: 120000,
          route: "/deals",
          bucket: "due_diligence",
        },
        {
          key: "estimating",
          label: "Estimating",
          count: 6,
          totalValue: 300000,
          route: "/deals",
          bucket: "estimating",
        },
      ],
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
    loading: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

vi.mock("@/hooks/use-tasks", () => ({
  useTasks: ({ section }: { section: string }) => ({
    tasks: section === "overdue" ? [] : [],
    refetch: vi.fn(),
  }),
}));

vi.mock("@/components/layout/page-header", () => ({
  PageHeader: ({ title, description }: { title: string; description?: string }) => (
    <div data-testid="page-header">
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
  PipelineBarChart: () => <div data-testid="pipeline-chart" />,
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
  MyCleanupCard: ({ total }: { total: number }) => (
    <a href="/pipeline/my-cleanup">{total} records need enrichment</a>
  ),
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

function normalize(source: string) {
  return source.replace(/\s+/g, " ").trim();
}

describe("RepDashboardPage", () => {
  it("surfaces the rep cleanup queue from the dashboard source", () => {
    const source = normalize(pageSource);

    expect(source).toContain("My Cleanup");
    expect(source).toContain('navigate("/pipeline/my-cleanup")');
    expect(source).toContain("Active Leads");
    expect(source).toContain("Today At A Glance");
    expect(source).toContain("Leads Snapshot");
    expect(source).toContain("Deals Snapshot");
    expect(source).toContain("10 at a time");
  });

  it("renders cleanup summary alongside the richer dashboard layout", () => {
    const html = normalize(
      renderToStaticMarkup(
        <MemoryRouter>
          <RepDashboardPage />
        </MemoryRouter>
      )
    );

    expect(html.indexOf("Leads")).toBeLessThan(html.indexOf("Today&#x27;s Tasks"));
    expect(html).toContain("Qualified Leads");
    expect(html).toContain("Due Diligence");
    expect(html).toContain("Estimating");
    expect(html).toContain("4 records need enrichment");
    expect(html).toContain('href="/pipeline/my-cleanup"');
  });
});
