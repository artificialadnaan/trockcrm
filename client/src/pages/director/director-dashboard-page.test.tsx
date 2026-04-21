import { type ReactNode } from "react";
import { describe, expect, it, beforeEach, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const {
  navigateSpy,
  mockDashboardData,
  setAutoSelectRep,
  shouldAutoSelectRep,
} = vi.hoisted(() => {
  const navigateSpy = vi.fn();
  const mockDashboardData = {
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
    staleDeals: [] as Array<{
      dealId: string;
      dealName: string;
      repName: string;
      daysInStage: number;
      stageName: string;
    }>,
    staleLeads: [] as Array<{
      leadId: string;
      leadName: string;
      repName: string;
      daysInStage: number;
      stageName: string;
    }>,
    ddVsPipeline: {
      ddValue: 90000,
      ddCount: 3,
      pipelineValue: 150000,
      pipelineCount: 4,
      totalValue: 240000,
      totalCount: 7,
    },
  };

  let autoSelectRep = false;

  return {
    navigateSpy,
    mockDashboardData,
    setAutoSelectRep(nextValue: boolean) {
      autoSelectRep = nextValue;
    },
    shouldAutoSelectRep() {
      return autoSelectRep;
    },
  };
});

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");

  return {
    ...actual,
    Link: ({
      to,
      children,
      ...props
    }: {
      to: string;
      children?: ReactNode;
      [key: string]: unknown;
    }) => (
      <a data-router-link="true" data-to={to} href={to} {...props}>
        {children}
      </a>
    ),
    useNavigate: () => navigateSpy,
  };
});

vi.mock("@/hooks/use-director-dashboard", () => ({
  presetToDateRange: vi.fn(() => ({ from: "2026-01-01", to: "2026-12-31" })),
  useDirectorDashboard: vi.fn(() => ({
    loading: false,
    error: null,
    data: mockDashboardData,
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

vi.mock("@/components/dashboard/director-rep-workspace", () => ({
  DirectorRepWorkspace: ({
    onSelectRep,
  }: {
    onSelectRep: (repId: string) => void;
  }) => {
    if (shouldAutoSelectRep()) {
      onSelectRep("rep-1");
    }

    return <div>Rep performance</div>;
  },
}));

import { MemoryRouter } from "react-router-dom";
import { DirectorDashboardPage } from "./director-dashboard-page";

describe("DirectorDashboardPage", () => {
  beforeEach(() => {
    navigateSpy.mockReset();
    setAutoSelectRep(false);
    mockDashboardData.repCards = [
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
    ];
    mockDashboardData.pipelineByStage = [];
    mockDashboardData.winRateTrend = [];
    mockDashboardData.activityByRep = [];
    mockDashboardData.staleDeals = [];
    mockDashboardData.staleLeads = [];
  });

  it("preserves dd vs pipeline, rep workspace, performance trends, and blind spots", () => {
    const html = renderToStaticMarkup(<DirectorDashboardPage />);

    expect(html).toContain("True pipeline");
    expect(html).toContain("DD pipeline");
    expect(html).toContain("Total pipeline");
    expect(html).toContain("Rep performance");
    expect(html).toContain("Performance trends");
    expect(html).toContain("Director Blind Spots");
  });

  it("keeps zero-activity reps visible in the summary layer", () => {
    const html = renderToStaticMarkup(<DirectorDashboardPage />);

    expect(html).toContain("Activity summary");
    expect(html).toContain("Alpha Rep");
    expect(html).toContain("0 activities");
  });

  it("uses router-based quick actions and rep drill-through inside router context", () => {
    mockDashboardData.staleDeals = [
      {
        dealId: "deal-1",
        dealName: "Deal One",
        repName: "Alpha Rep",
        daysInStage: 21,
        stageName: "Proposal",
      },
    ];
    mockDashboardData.staleLeads = [
      {
        leadId: "lead-1",
        leadName: "Lead One",
        repName: "Alpha Rep",
        daysInStage: 14,
        stageName: "Qualified",
      },
    ];
    setAutoSelectRep(true);

    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/director"]}>
        <DirectorDashboardPage />
      </MemoryRouter>
    );

    expect(html).toContain('data-router-link="true"');
    expect(html).toContain('data-to="/reports"');
    expect(html).toContain('data-to="/admin/ai-actions"');
    expect(html).toContain('data-to="/reports/stale-deals"');
    expect(html).toContain('data-to="/reports"');
    expect(navigateSpy).toHaveBeenCalledWith("/director/rep/rep-1");
  });
});
