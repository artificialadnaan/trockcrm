import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
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
        activeDeals: { count: 3, totalValue: 100000 },
        tasksToday: { overdue: 1, today: 2 },
        activityThisWeek: { calls: 1, emails: 2, meetings: 0, notes: 0, total: 3 },
        followUpCompliance: { total: 3, onTime: 2, complianceRate: 67 },
        pipelineByStage: [],
        staleLeads: { count: 1, averageDaysInStage: 8, leads: [] },
      },
    });
    mocks.useDealBoardMock.mockReturnValue({ board: { columns: [] } });
    mocks.useLeadBoardMock.mockReturnValue({ board: { columns: [], defaultConversionDealStageId: null } });
  });

  it("shows the rep board before secondary metrics", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <RepDashboardPage />
      </MemoryRouter>
    );

    expect(html).toContain("My Board");
    expect(html).toContain("aria-pressed=\"true\"");
    expect(html).toContain("Stale Leads");
  });
});
