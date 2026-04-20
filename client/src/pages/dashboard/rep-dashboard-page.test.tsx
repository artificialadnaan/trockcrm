import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { RepDashboardPage } from "./rep-dashboard-page";

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: { displayName: "Alex Rep" },
  }),
}));

vi.mock("@/hooks/use-dashboard", () => ({
  useRepDashboard: () => ({
    data: {
      funnelBuckets: [
        { key: "lead", label: "Leads", count: 4, totalValue: null, route: "/leads", bucket: "lead" },
        { key: "qualified_lead", label: "Qualified Leads", count: 2, totalValue: null, route: "/leads", bucket: "qualified_lead" },
        { key: "opportunity", label: "Opportunities", count: 3, totalValue: null, route: "/leads", bucket: "opportunity" },
        { key: "due_diligence", label: "Due Diligence", count: 5, totalValue: 120000, route: "/deals", bucket: "due_diligence" },
        { key: "estimating", label: "Estimating", count: 6, totalValue: 300000, route: "/deals", bucket: "estimating" },
      ],
      activeDeals: { count: 6, totalValue: 300000 },
      tasksToday: { overdue: 1, today: 2 },
      activityThisWeek: { calls: 1, emails: 2, meetings: 3, notes: 4, total: 10 },
      followUpCompliance: { total: 5, onTime: 4, complianceRate: 80 },
      pipelineByStage: [],
      staleLeads: { count: 0, averageDaysInStage: null, leads: [] },
    },
    loading: false,
    error: null,
    refetch: vi.fn(),
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

function normalize(html: string) {
  return html.replace(/\s+/g, " ").trim();
}

describe("RepDashboardPage", () => {
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
