import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { DirectorDashboardPage } from "./director-dashboard-page";

vi.mock("@/hooks/use-director-dashboard", () => ({
  presetToDateRange: () => ({ from: "2026-01-01", to: "2026-12-31" }),
  useDirectorDashboard: () => ({
    data: {
      officeFunnelBuckets: [
        { key: "lead", label: "Leads", count: 8, totalValue: null, route: "/leads", bucket: "lead" },
        { key: "qualified_lead", label: "Qualified Leads", count: 3, totalValue: null, route: "/leads", bucket: "qualified_lead" },
        { key: "opportunity", label: "Opportunities", count: 2, totalValue: null, route: "/leads", bucket: "opportunity" },
        { key: "due_diligence", label: "Due Diligence", count: 4, totalValue: 90000, route: "/deals", bucket: "due_diligence" },
        { key: "estimating", label: "Estimating", count: 5, totalValue: 210000, route: "/deals", bucket: "estimating" },
      ],
      repFunnelRows: [
        { repId: "rep-1", repName: "Alex Rep", leads: 3, qualifiedLeads: 1, opportunities: 1, dueDiligence: 2, estimating: 2 },
      ],
      repCards: [],
      pipelineByStage: [],
      winRateTrend: [],
      activityByRep: [],
      staleDeals: [],
      staleLeads: [],
      ddVsPipeline: { ddValue: 0, ddCount: 0, pipelineValue: 0, pipelineCount: 0, totalValue: 0, totalCount: 0 },
    },
    loading: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

vi.mock("@/hooks/use-rep-performance", () => ({
  useRepPerformance: () => ({
    data: { reps: [] },
    loading: false,
    error: null,
  }),
}));

vi.mock("@/components/ai/director-blind-spot-list", () => ({
  DirectorBlindSpotList: () => <div>Blind spots</div>,
}));

function normalize(html: string) {
  return html.replace(/\s+/g, " ").trim();
}

describe("DirectorDashboardPage", () => {
  it("renders the funnel row and rep-by-rep table before broader metrics", () => {
    const html = normalize(
      renderToStaticMarkup(
        <MemoryRouter>
          <DirectorDashboardPage />
        </MemoryRouter>
      )
    );

    expect(html).toContain("Qualified Leads");
    expect(html).toContain("Alex Rep");
    expect(html.indexOf("Qualified Leads")).toBeLessThan(html.indexOf("True Pipeline"));
  });
});
