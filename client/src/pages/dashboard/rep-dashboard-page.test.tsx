import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";
import { RepDashboardPage } from "./rep-dashboard-page";

const mocks = vi.hoisted(() => ({
  useRepDashboardMock: vi.fn(),
  useAuthMock: vi.fn(),
  useTasksMock: vi.fn(),
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

vi.mock("@/components/dashboard/stat-card", () => ({
  StatCard: ({ title, value, subtitle }: { title: string; value: ReactNode; subtitle?: ReactNode }) => (
    <section>
      <h3>{title}</h3>
      <p>{value}</p>
      {subtitle ? <p>{subtitle}</p> : null}
    </section>
  ),
}));

vi.mock("@/components/charts/pipeline-bar-chart", () => ({
  PipelineBarChart: ({ data }: { data: Array<{ stageName: string }> }) => (
    <div>{data.map((row) => row.stageName).join(", ")}</div>
  ),
}));

vi.mock("@/components/charts/chart-colors", () => ({
  formatCurrency: (value: number) => `$${value.toLocaleString()}`,
}));

vi.mock("@/lib/pipeline-ownership", () => ({
  getWorkflowRouteLabel: (route: "normal" | "service") => (route === "service" ? "Service" : "Normal"),
}));

vi.mock("@/components/tasks/task-section", () => ({
  TaskSection: ({ title, count }: { title: string; count: number }) => (
    <div>{title} ({count})</div>
  ),
}));

vi.mock("@/components/ui/card", () => ({
  Card: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  CardContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

function normalize(html: string) {
  return html.replace(/\s+/g, " ").trim();
}

describe("RepDashboardPage", () => {
  beforeEach(() => {
    mocks.useAuthMock.mockReturnValue({ user: { displayName: "Avery Rep" } });
    mocks.useTasksMock.mockReturnValue({ tasks: [], refetch: vi.fn() });
    mocks.useRepDashboardMock.mockReturnValue({
      loading: false,
      error: null,
      data: {
        activeDeals: { count: 6, totalValue: 910000 },
        tasksToday: { overdue: 1, today: 2 },
        activityThisWeek: { calls: 8, emails: 5, meetings: 2, notes: 4, total: 19 },
        followUpCompliance: { total: 10, onTime: 9, complianceRate: 90 },
        pipelineByStage: [{ stageId: "opportunity", stageName: "Opportunity", stageColor: null, dealCount: 3, totalValue: 450000 }],
        crmOwnedProgression: [
          { workflowBucket: "lead", workflowRoute: "normal", stageName: "Qualified Lead", itemCount: 2, totalValue: 125000 },
          { workflowBucket: "opportunity", workflowRoute: "service", stageName: "Opportunity", itemCount: 3, totalValue: 450000 },
        ],
        downstreamBottlenecks: [
          {
            dealId: "deal-1",
            dealName: "Dallas ISD Roof",
            stageName: "Estimating",
            mirroredStageStatus: "blocked",
            workflowRoute: "service",
            regionClassification: "Dallas, TX",
            dealValue: 275000,
            daysInStage: 22,
            staleThresholdDays: 14,
          },
        ],
        staleLeads: {
          count: 1,
          averageDaysInStage: 16,
          leads: [{
            leadId: "lead-1",
            leadName: "North Campus",
            companyName: "North Star",
            propertyName: "Austin Campus",
            stageName: "Qualified Lead",
            repName: "Avery Rep",
            daysInStage: 16,
            pipelineType: "normal",
            locationLabel: "Austin, TX",
            estimatedValue: 92000,
            staleThresholdDays: 14,
          }],
        },
      },
    });
  });

  it("renders CRM-owned progression and mirrored downstream bottlenecks with route, region, value, and timer context", () => {
    const html = normalize(
      renderToStaticMarkup(
        <MemoryRouter>
          <RepDashboardPage />
        </MemoryRouter>
      )
    );

    expect(html).toContain("CRM-Owned Progression");
    expect(html).toContain("Qualified Lead");
    expect(html).toContain("Opportunity");
    expect(html).toContain("Service path");
    expect(html).toContain("Bid Board Bottlenecks");
    expect(html).toContain("Dallas ISD Roof");
    expect(html).toContain("blocked");
    expect(html).toContain("Dallas, TX");
    expect(html).toContain("$275,000");
    expect(html).toContain("22d / 14d target");
  });
});
