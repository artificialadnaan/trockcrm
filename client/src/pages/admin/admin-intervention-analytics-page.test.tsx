import { MemoryRouter } from "react-router-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { AdminInterventionAnalyticsPage } from "./admin-intervention-analytics-page";

vi.mock("@/hooks/use-ai-ops", () => ({
  useInterventionAnalytics: () => ({
    data: {
      summary: {
        openCases: 4,
        overdueCases: 2,
        escalatedCases: 1,
        snoozeOverdueCases: 1,
        repeatOpenCases: 1,
        openCasesBySeverity: { critical: 1, high: 2, medium: 1, low: 0 },
        overdueCasesBySeverity: { critical: 1, high: 1, medium: 0, low: 0 },
      },
      outcomes: {
        clearanceRate30d: 0.5,
        reopenRate30d: 0.25,
        averageAgeOfOpenCases: 3,
        medianAgeOfOpenCases: 2,
        averageAgeToResolution: 4,
        actionVolume30d: { assign: 4, snooze: 3, resolve: 6, escalate: 1 },
      },
      hotspots: {
        assignees: [
          {
            key: "manager-1",
            entityType: "assignee",
            filterValue: "manager-1",
            label: "Manager One",
            openCases: 3,
            overdueCases: 2,
            repeatOpenCases: 1,
            clearanceRate30d: 0.5,
            queueLink: "/admin/interventions?view=overdue&assigneeId=manager-1",
          },
        ],
        disconnectTypes: [],
        reps: [],
        companies: [],
        stages: [],
      },
      breachQueue: {
        items: [
          {
            caseId: "case-1",
            severity: "critical",
            disconnectType: "missing_next_task",
            dealId: "deal-1",
            dealLabel: "D-1001 Alpha Plaza",
            companyId: "company-1",
            companyLabel: "Acme Property Group",
            ageDays: 3,
            assignedTo: "manager-1",
            escalated: true,
            breachReasons: ["overdue", "escalated_open"],
            detailLink: "/admin/interventions?caseId=case-1",
            queueLink: "/admin/interventions?view=overdue&caseId=case-1",
          },
        ],
        totalCount: 1,
        pageSize: 25,
      },
      slaRules: {
        criticalDays: 0,
        highDays: 2,
        mediumDays: 5,
        lowDays: 10,
        timingBasis: "business_days",
      },
    },
    loading: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

describe("AdminInterventionAnalyticsPage", () => {
  it("renders summary, hotspots, and breach queue", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AdminInterventionAnalyticsPage />
      </MemoryRouter>
    );

    expect(html).toContain("Intervention Analytics");
    expect(html).toContain("Open Cases");
    expect(html).toContain("Breach Queue");
  });
});
