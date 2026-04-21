import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

const mocks = vi.hoisted(() => ({
  useDirectorDashboardMock: vi.fn(),
  usePipelineBoardStateMock: vi.fn(),
  useDealBoardMock: vi.fn(),
  useLeadBoardMock: vi.fn(),
}));

vi.mock("@/hooks/use-director-dashboard", () => ({ useDirectorDashboard: mocks.useDirectorDashboardMock }));
vi.mock("@/hooks/use-pipeline-board-state", () => ({ usePipelineBoardState: mocks.usePipelineBoardStateMock }));
vi.mock("@/hooks/use-deals", () => ({ useDealBoard: mocks.useDealBoardMock }));
vi.mock("@/hooks/use-leads", () => ({ useLeadBoard: mocks.useLeadBoardMock }));

import { DirectorDashboardPage } from "./director-dashboard-page";

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
        repCards: [],
        pipelineByStage: [],
        winRateTrend: [],
        activityByRep: [],
        staleDeals: [{ dealId: "deal-1" }],
        staleLeads: [{ leadId: "lead-1" }],
        ddVsPipeline: { ddValue: 0, ddCount: 0, pipelineValue: 500000, pipelineCount: 8, totalValue: 500000, totalCount: 8 },
      },
    });
    mocks.useDealBoardMock.mockReturnValue({ board: { columns: [] } });
    mocks.useLeadBoardMock.mockReturnValue({ board: { columns: [], defaultConversionDealStageId: null } });
  });

  it("shows the team board switcher and stage-pressure workspace before the trend panels", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <DirectorDashboardPage />
      </MemoryRouter>
    );

    expect(html).toContain("Team Pipeline Console");
    expect(html).toContain("aria-pressed=\"true\"");
    expect(html).toContain("Stale Deals");
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
