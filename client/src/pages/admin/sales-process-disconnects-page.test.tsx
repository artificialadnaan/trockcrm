import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SalesProcessDisconnectsPage } from "./sales-process-disconnects-page";

const mocks = vi.hoisted(() => ({
  queueAiDisconnectAdminTasks: vi.fn(() => Promise.resolve({ queued: true, mode: "manual" })),
  queueAiDisconnectDigest: vi.fn(() => Promise.resolve({ queued: true, mode: "manual" })),
  queueAiDisconnectEscalationScan: vi.fn(() => Promise.resolve({ queued: true, mode: "manual" })),
  trackSalesProcessDisconnectInteraction: vi.fn(() => Promise.resolve()),
  useSalesProcessDisconnectDashboard: vi.fn(),
}));

vi.mock("@/hooks/use-ai-ops", () => mocks);

const dashboard = {
  summary: {
    activeDeals: 8,
    totalDisconnects: 5,
    staleStageCount: 2,
    missingNextTaskCount: 1,
    inboundWithoutFollowupCount: 1,
    revisionLoopCount: 1,
    estimatingGateGapCount: 1,
    procoreBidBoardDriftCount: 0,
  },
  automation: {
    digestNotifications7d: 3,
    escalationNotifications7d: 1,
    adminTasksCreated7d: 2,
    adminTasksOpen: 4,
    latestDigestAt: "2026-04-16T12:00:00.000Z",
    latestEscalationAt: "2026-04-16T13:00:00.000Z",
    latestAdminTaskCreatedAt: "2026-04-16T14:00:00.000Z",
  },
  narrative: {
    headline: "Follow-through is slipping on missing next task cases.",
    summary: "The office is carrying a small but stubborn set of stalled handoffs.",
    whatChanged: "Missing next task disconnects are now the primary signal.",
    adminFocus: "Push the open queue and watch the cluster follow-through gap.",
    recommendedActions: [
      "Clear the missing next task cluster first.",
      "Validate follow-up on the rep-owned queue.",
    ],
  },
  byType: [
    { disconnectType: "missing_next_task", label: "Missing Next Task", count: 3 },
    { disconnectType: "stale_stage", label: "Stale Stage", count: 2 },
  ],
  clusters: [
    {
      clusterKey: "follow_through_gap",
      title: "Follow-through Gap",
      summary: "Cases where the next action never got picked up.",
      likelyRootCause: "A missing handoff leaves the case idle.",
      recommendedAction: "Assign and confirm the next task.",
      severity: "high",
      dealCount: 2,
      disconnectCount: 3,
      disconnectTypes: ["missing_next_task"],
      stages: ["In Progress"],
      reps: ["Rep One"],
      includesProcoreBidBoard: false,
    },
  ],
  trends: {
    reps: [
      {
        key: "rep-one",
        label: "Rep One",
        disconnectCount: 2,
        dealCount: 2,
        criticalCount: 1,
        recentInterventionCount: 1,
        clusterKeys: ["follow_through_gap"],
      },
    ],
    stages: [],
    companies: [
      {
        key: "company-one",
        label: "Company One",
        disconnectCount: 1,
        dealCount: 1,
        criticalCount: 0,
        recentInterventionCount: 0,
        clusterKeys: ["follow_through_gap"],
      },
    ],
  },
  outcomes: {
    interventionDeals30d: 2,
    clearedAfterIntervention30d: 1,
    stillOpenAfterIntervention30d: 1,
    unresolvedEscalationsOpen: 0,
    repeatIssueDealsOpen: 0,
    repeatClusterDealsOpen: 0,
    interventionCoverageRate: 0.5,
    clearanceRate30d: 0.5,
  },
  actionSummary: {
    markReviewed30d: 1,
    resolve30d: 1,
    dismiss30d: 0,
    escalate30d: 1,
    bestOverallAction: "resolve",
    bestOverallClearanceRate: 0.5,
  },
  playbooks: [
    {
      clusterKey: "follow_through_gap",
      title: "Follow-through Gap",
      bestAction: "resolve",
      recommendedAction: "resolve",
      interventionDeals30d: 2,
      stillOpenDeals30d: 1,
      actions: [
        {
          action: "resolve",
          interventionDeals30d: 2,
          clearedDeals30d: 1,
          stillOpenDeals30d: 1,
          clearanceRate30d: 0.5,
        },
      ],
    },
  ],
  rows: [
    {
      id: "deal-1",
      dealNumber: "D-1001",
      dealName: "Alpha Plaza",
      companyId: "company-1",
      companyName: "Company One",
      stageName: "Proposal",
      estimatingSubstage: null,
      assignedRepName: "Rep One",
      disconnectType: "missing_next_task",
      disconnectLabel: "Missing next task",
      disconnectSeverity: "high",
      disconnectSummary: "A next task was never created.",
      disconnectDetails: "The case is stalled until the handoff is repaired.",
      ageDays: 4,
      openTaskCount: 1,
      inboundWithoutFollowupCount: 1,
      lastActivityAt: "2026-04-16T11:00:00.000Z",
      latestCustomerEmailAt: "2026-04-15T11:00:00.000Z",
      proposalStatus: "active",
      procoreSyncStatus: null,
      procoreSyncDirection: null,
      procoreLastSyncedAt: null,
      procoreSyncUpdatedAt: null,
      procoreDriftReason: null,
    },
  ],
};

beforeEach(() => {
  mocks.useSalesProcessDisconnectDashboard.mockReturnValue({
    dashboard,
    loading: false,
    error: null,
    refetch: vi.fn(),
  });
});

describe("SalesProcessDisconnectsPage", () => {
  it("renders source signals and preserves URL-backed downstream links", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter
        initialEntries={["/admin/sales-process-disconnects?type=missing_next_task&cluster=follow_through_gap&trend=companies"]}
      >
        <SalesProcessDisconnectsPage />
      </MemoryRouter>
    );

    expect(html).toContain("Sales Process Disconnects");
    expect(html).toContain("View Intervention Analytics");
    expect(html).toContain("Open Intervention Workspace");
    expect(html).toContain("Weekly Management Narrative");
    expect(html).toContain("Automation Status");
    expect(html).not.toContain("Intervention Outcomes");
    expect(html).not.toContain("Action Scoreboard");
    expect(html).not.toContain("Intervention Playbooks");
    expect(html).toContain(
      'href="/admin/intervention-analytics?type=missing_next_task&amp;cluster=follow_through_gap&amp;trend=companies"'
    );
    expect(html).toContain(
      'href="/admin/interventions?type=missing_next_task&amp;cluster=follow_through_gap&amp;trend=companies"'
    );
  });
});
