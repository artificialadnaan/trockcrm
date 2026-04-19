import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagerAlertSnapshot } from "@/hooks/use-ai-ops";

import {
  AdminInterventionAnalyticsPage,
  selectNewestManagerAlertSnapshot,
  shouldShowManagerAlertHookError,
} from "./admin-intervention-analytics-page";

const mocks = vi.hoisted(() => ({
  useInterventionAnalytics: vi.fn(),
  useManagerAlertSnapshot: vi.fn(),
}));

const analyticsData = {
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
  outcomeEffectiveness: {
    reopenRateByConclusionFamily: { resolve: 0.5, snooze: 0.25, escalate: 0 },
    reopenRateByResolveCategory: [{ key: "owner_aligned", rate: 0.5, count: 2 }],
    reopenRateBySnoozeReason: [{ key: "waiting_on_customer", rate: 0.25, count: 4 }],
    reopenRateByEscalationReason: [{ key: "manager_visibility_required", rate: 0, count: 1 }],
    conclusionMixByDisconnectType: [{ key: "missing_next_task", resolveCount: 3, snoozeCount: 1, escalateCount: 1 }],
    conclusionMixByActingUser: [{ actorUserId: "director-1", actorName: "Director One", resolveCount: 3, snoozeCount: 1, escalateCount: 1 }],
    conclusionMixByAssigneeAtConclusion: [{ assigneeId: "manager-1", assigneeName: "Manager One", resolveCount: 2, snoozeCount: 1, escalateCount: 1 }],
    medianDaysToReopenByConclusionFamily: [{ key: "resolve", medianDays: 3 }],
  },
};

const managerAlertSnapshot: ManagerAlertSnapshot = {
  id: "snapshot-1",
  officeId: "office-1",
  snapshotKind: "manager_alert_summary",
  snapshotMode: "preview",
  snapshotJson: {
    version: 1,
    officeId: "office-1",
    timezone: "America/Chicago",
    officeLocalDate: "2026-04-16",
    generatedAt: "2026-04-16T13:00:00.000Z",
    link: "/admin/intervention-analytics",
    families: {
      overdueHighCritical: {
        count: 2,
        queueLink: "/admin/interventions?view=overdue",
        caseIds: ["case-1", "case-2"],
      },
      snoozeBreached: {
        count: 1,
        queueLink: "/admin/interventions?view=snooze-breached",
        caseIds: ["case-3"],
      },
      escalatedOpen: {
        count: 1,
        queueLink: "/admin/interventions?view=escalated",
        caseIds: ["case-4"],
      },
      assigneeOverload: {
        count: 1,
        threshold: 15,
        queueLink: null,
        items: [
          {
            assigneeId: "manager-1",
            assigneeLabel: "Manager One",
            totalWeight: 18,
            caseCount: 4,
            queueLink: "/admin/interventions?view=all&assigneeId=manager-1",
          },
        ],
      },
    },
  },
  scannedAt: "2026-04-16T13:00:00.000Z",
  sentAt: null,
  createdAt: "2026-04-16T13:00:00.000Z",
  updatedAt: "2026-04-16T13:00:00.000Z",
};

beforeEach(() => {
  mocks.useInterventionAnalytics.mockReturnValue({
    data: analyticsData,
    loading: false,
    error: null,
    refetch: vi.fn(),
  });
  mocks.useManagerAlertSnapshot.mockReturnValue({
    data: managerAlertSnapshot,
    loading: false,
    error: null,
    refetch: vi.fn(),
  });
});

vi.mock("@/components/ai/intervention-analytics-breach-queue", () => ({
  InterventionAnalyticsBreachQueue: () => <div>Breach Queue</div>,
}));

vi.mock("@/components/ai/intervention-analytics-hotspots", () => ({
  InterventionAnalyticsHotspots: () => <div>Hotspots</div>,
}));

vi.mock("@/components/ai/intervention-analytics-outcomes", () => ({
  InterventionAnalyticsOutcomes: () => <div>Outcomes</div>,
}));

vi.mock("@/components/ai/intervention-analytics-sla-rules", () => ({
  InterventionAnalyticsSlaRules: () => <div>SLA Rules</div>,
}));

vi.mock("@/components/ai/intervention-analytics-summary-strip", () => ({
  InterventionAnalyticsSummaryStrip: ({ summary }: { summary: { openCases: number } }) => (
    <div>Open Cases: {summary.openCases}</div>
  ),
}));

vi.mock("@/components/ai/intervention-effectiveness-summary", () => ({
  InterventionEffectivenessSummary: () => <div>Resolution Effectiveness</div>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children }: { children: ReactNode }) => <button>{children}</button>,
  buttonVariants: () => "",
}));

vi.mock("@/components/ui/card", () => ({
  Card: ({ children }: { children: ReactNode }) => <section>{children}</section>,
  CardContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardDescription: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/hooks/use-ai-ops", () => ({
  useInterventionAnalytics: mocks.useInterventionAnalytics,
  useManagerAlertSnapshot: mocks.useManagerAlertSnapshot,
}));

describe("AdminInterventionAnalyticsPage", () => {
  it("hides stale manager alert hook errors once snapshot content is available", () => {
    expect(shouldShowManagerAlertHookError("fetch failed", null)).toBe(true);
    expect(shouldShowManagerAlertHookError("fetch failed", managerAlertSnapshot)).toBe(false);
  });

  it("keeps the newer manager alert snapshot when older hook data arrives later", () => {
    const newerSnapshot = {
      ...managerAlertSnapshot,
      sentAt: "2026-04-16T13:05:00.000Z",
      updatedAt: "2026-04-16T13:05:00.000Z",
    };
    const olderSnapshot = {
      ...managerAlertSnapshot,
      scannedAt: "2026-04-16T13:00:00.000Z",
      createdAt: "2026-04-16T13:00:00.000Z",
      updatedAt: "2026-04-16T13:00:00.000Z",
    };

    expect(selectNewestManagerAlertSnapshot(newerSnapshot, olderSnapshot)).toBe(newerSnapshot);
    expect(selectNewestManagerAlertSnapshot(olderSnapshot, newerSnapshot)).toBe(newerSnapshot);
  });

  it("renders the manager alerts panel alongside analytics content", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AdminInterventionAnalyticsPage />
      </MemoryRouter>
    );

    expect(html).toContain("Intervention Analytics");
    expect(html).toContain("Queue Health");
    expect(html).toContain("Manager Alerts");
    expect(html).toContain("Outcome Effectiveness");
    expect(html).toContain("Policy Recommendations");
    expect(html).not.toContain("Manager Readout");
    expect(html).toContain("Run Manager Alert Scan");
    expect(html).toContain("Send Alerts");
    expect(html).toContain("Office-local time");
    expect(html).toContain("Open Cases");
    expect(html).toContain("Resolution Effectiveness");
    expect(html).toContain("Breach Queue");
    expect(html).toContain("Manager One");
    expect(html).toContain('href="#queue-health"');
    expect(html).toContain('href="#manager-alerts"');
    expect(html).toContain('href="#outcome-effectiveness"');
    expect(html).toContain('href="#policy-recommendations"');
    expect(html).toContain('id="queue-health"');
    expect(html).toContain('id="manager-alerts"');
    expect(html).toContain('id="outcome-effectiveness"');
    expect(html).toContain('id="policy-recommendations"');
  });

  it("preserves source filters on cross-links to the other manager surfaces", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter
        initialEntries={["/admin/intervention-analytics?type=overdue&cluster=manager&trend=critical"]}
      >
        <AdminInterventionAnalyticsPage />
      </MemoryRouter>
    );

    expect(html).toContain('href="/admin/interventions?type=overdue&amp;cluster=manager&amp;trend=critical"');
    expect(html).toContain('href="/admin/sales-process-disconnects?type=overdue&amp;cluster=manager&amp;trend=critical"');
    expect(html).toContain('href="/admin/interventions?view=overdue&amp;type=overdue&amp;cluster=manager&amp;trend=critical"');
    expect(html).toContain(
      'href="/admin/interventions?view=all&amp;assigneeId=manager-1&amp;type=overdue&amp;cluster=manager&amp;trend=critical"'
    );
  });

  it("keeps manager alerts visible when general analytics data is unavailable", () => {
    mocks.useInterventionAnalytics.mockReturnValueOnce({
      data: null,
      loading: false,
      error: null,
      refetch: vi.fn(),
    });

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AdminInterventionAnalyticsPage />
      </MemoryRouter>
    );

    expect(html).toContain("Manager Alerts");
    expect(html).toContain("Intervention analytics are unavailable right now.");
    expect(html).toContain("Run Manager Alert Scan");
  });
});
