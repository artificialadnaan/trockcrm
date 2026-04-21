import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/hooks/use-director-dashboard", () => ({
  presetToDateRange: vi.fn(() => ({ from: "2026-01-01", to: "2026-12-31" })),
  useDirectorDashboard: vi.fn(() => ({
    loading: false,
    error: null,
    data: {
      repCards: [
        {
          repId: "rep-1",
          repName: "Alpha Rep",
          activeDeals: 4,
          pipelineValue: 150000,
          winRate: 40,
          activityScore: 12,
          staleDeals: 1,
          staleLeads: 0,
        },
      ],
      pipelineByStage: [],
      winRateTrend: [],
      activityByRep: [],
      staleDeals: [],
      staleLeads: [],
      ddVsPipeline: {
        ddValue: 90000,
        ddCount: 3,
        pipelineValue: 150000,
        pipelineCount: 4,
        totalValue: 240000,
        totalCount: 7,
      },
    },
  })),
}));

vi.mock("@/hooks/use-rep-performance", () => ({
  useRepPerformance: vi.fn(() => ({
    loading: false,
    data: {
      reps: [],
      periodLabel: { current: "This Month", previous: "Last Month" },
    },
  })),
}));

vi.mock("@/components/ai/director-blind-spot-list", () => ({
  DirectorBlindSpotList: () => <div>Director Blind Spots</div>,
}));

import { DirectorDashboardPage } from "./director-dashboard-page";

describe("DirectorDashboardPage", () => {
  it("preserves dd vs pipeline, rep workspace, performance trends, and blind spots", () => {
    const html = renderToStaticMarkup(<DirectorDashboardPage />);

    expect(html).toContain("True pipeline");
    expect(html).toContain("DD pipeline");
    expect(html).toContain("Total pipeline");
    expect(html).toContain("Rep performance");
    expect(html).toContain("Performance trends");
    expect(html).toContain("Director Blind Spots");
  });
});
