import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { RepDashboardPage } from "./rep-dashboard-page";

const mocks = vi.hoisted(() => ({
  useRepDashboardMock: vi.fn(),
  useAuthMock: vi.fn(),
  useTasksMock: vi.fn(),
  useNavigateMock: vi.fn(),
}));

vi.mock("@/hooks/use-dashboard", () => ({
  useRepDashboard: mocks.useRepDashboardMock,
}));

vi.mock("@/lib/auth", () => ({
  useAuth: mocks.useAuthMock,
}));

vi.mock("@/hooks/use-tasks", () => ({
  useTasks: mocks.useTasksMock,
}));

vi.mock("@/components/charts/pipeline-bar-chart", () => ({
  PipelineBarChart: () => <div data-testid="pipeline-chart" />,
}));

vi.mock("@/components/charts/chart-colors", () => ({
  formatCurrency: (value: number) => `$${value.toLocaleString()}`,
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

vi.mock("@/components/dashboard/stat-card", () => ({
  StatCard: ({ title, value }: { title: string; value: string | number }) => (
    <div data-testid={`stat-${title}`}>{value}</div>
  ),
}));

vi.mock("@/components/tasks/task-section", () => ({
  TaskSection: () => <div data-testid="task-section" />,
}));

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mocks.useNavigateMock,
  };
});

function renderPage() {
  return renderToStaticMarkup(
    <MemoryRouter>
      <RepDashboardPage />
    </MemoryRouter>
  );
}

describe("RepDashboardPage", () => {
  beforeEach(() => {
    mocks.useAuthMock.mockReturnValue({
      user: { displayName: "Avery Stone" },
    });
    mocks.useRepDashboardMock.mockReturnValue({
      data: {
        activeDeals: { count: 8, totalValue: 1250000 },
        tasksToday: { overdue: 1, today: 3 },
        activityThisWeek: { calls: 5, emails: 9, meetings: 2, notes: 4, total: 20 },
        followUpCompliance: { total: 12, onTime: 10, complianceRate: 83 },
        pipelineByStage: [],
        staleLeads: { count: 0, averageDaysInStage: null, leads: [] },
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
    });
    mocks.useTasksMock.mockReturnValue({
      tasks: [],
      refetch: vi.fn(),
    });
    mocks.useNavigateMock.mockReset();
  });

  it("renders the cleanup summary card with a drill-in link", () => {
    const html = renderPage();

    expect(html).toContain("My Cleanup");
    expect(html).toContain("4 records need enrichment");
    expect(html).toContain("Open queue");
    expect(html).toContain('href="/pipeline/my-cleanup"');
  });
});
