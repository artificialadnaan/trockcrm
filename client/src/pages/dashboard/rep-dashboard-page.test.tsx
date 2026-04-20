import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
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
    },
    loading: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

vi.mock("@/hooks/use-sales-review", () => ({
  useSalesReview: () => ({
    data: {
      hygiene: [{ issueTypes: ["unassigned_owner"] }, { issueTypes: ["missing_next_step"] }],
    },
  }),
}));

vi.mock("@/hooks/use-tasks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/use-tasks")>();
  return {
    ...actual,
    useTasks: ({ section }: { section: string }) => ({
      tasks: section === "overdue" ? [] : [],
      refetch: vi.fn(),
    }),
  };
});

function normalize(source: string) {
  return source.replace(/\s+/g, " ").trim();
}

describe("RepDashboardPage", () => {
  it("surfaces the rep cleanup queue from the dashboard source", () => {
    const source = normalize(pageSource);

    expect(source).toContain('import { useSalesReview } from "@/hooks/use-sales-review";');
    expect(source).toContain("My Cleanup");
    expect(source).toContain('navigate("/pipeline/hygiene")');
    expect(source).toContain("Active Leads");
    expect(source).toContain("Today At A Glance");
    expect(source).toContain("Leads Snapshot");
    expect(source).toContain("Deals Snapshot");
    expect(source).toContain("10 at a time");
  });

  it("renders funnel buckets before today's tasks", () => {
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
  });
});
