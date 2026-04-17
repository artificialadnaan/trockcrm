import { describe, expect, it } from "vitest";

const { getInterventionAnalyticsDashboard } = await import("../../../src/modules/ai-copilot/intervention-service");

type DisconnectCaseRecord = {
  id: string;
  officeId: string;
  scopeType: string;
  scopeId: string;
  dealId: string | null;
  companyId: string | null;
  disconnectType: string;
  clusterKey: string | null;
  businessKey: string;
  severity: string;
  status: "open" | "snoozed" | "resolved";
  assignedTo: string | null;
  generatedTaskId: string | null;
  escalated: boolean;
  snoozedUntil: Date | null;
  reopenCount: number;
  firstDetectedAt: Date;
  lastDetectedAt: Date;
  currentLifecycleStartedAt: Date;
  lastReopenedAt: Date | null;
  lastIntervenedAt: Date | null;
  resolvedAt: Date | null;
  resolutionReason: string | null;
  metadataJson: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
};

type DealRecord = {
  id: string;
  dealNumber: string;
  name: string;
  companyId: string | null;
};

type CompanyRecord = {
  id: string;
  name: string;
};

type HistoryRecord = {
  id: string;
  disconnectCaseId: string;
  actionType: string;
  actedBy: string;
  actedAt: Date;
  fromStatus: string | null;
  toStatus: string | null;
  fromAssignee: string | null;
  toAssignee: string | null;
  fromSnoozedUntil: Date | null;
  toSnoozedUntil: Date | null;
  notes: string | null;
  metadataJson: Record<string, unknown> | null;
};

function makeCase(
  overrides: Partial<DisconnectCaseRecord> = {},
  now = new Date("2026-04-16T12:00:00.000Z")
): DisconnectCaseRecord {
  return {
    id: "case-1",
    officeId: "office-1",
    scopeType: "deal",
    scopeId: "deal-1",
    dealId: "deal-1",
    companyId: "company-1",
    disconnectType: "missing_next_task",
    clusterKey: "follow_through_gap",
    businessKey: "office-1:missing_next_task:deal:deal-1",
    severity: "high",
    status: "open",
    assignedTo: "manager-1",
    generatedTaskId: null,
    escalated: false,
    snoozedUntil: null,
    reopenCount: 0,
    firstDetectedAt: now,
    lastDetectedAt: now,
    currentLifecycleStartedAt: now,
    lastReopenedAt: null,
    lastIntervenedAt: null,
    resolvedAt: null,
    resolutionReason: null,
    metadataJson: {
      evidenceSummary: "Deal has no open next-step task.",
      dealName: "Alpha Plaza",
      dealNumber: "D-1001",
      companyName: "Acme Property Group",
      stageKey: "estimating",
      stageName: "Estimating",
      assignedRepId: "rep-1",
      assignedRepName: "Rep One",
    },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeHistory(overrides: Partial<HistoryRecord> = {}): HistoryRecord {
  return {
    id: "history-1",
    disconnectCaseId: "case-1",
    actionType: "assign",
    actedBy: "admin-1",
    actedAt: new Date("2026-04-15T12:00:00.000Z"),
    fromStatus: "open",
    toStatus: "open",
    fromAssignee: null,
    toAssignee: "manager-1",
    fromSnoozedUntil: null,
    toSnoozedUntil: null,
    notes: null,
    metadataJson: null,
    ...overrides,
  };
}

function createTenantDb(state?: {
  cases?: DisconnectCaseRecord[];
  deals?: DealRecord[];
  companies?: CompanyRecord[];
  users?: Array<{ id: string; displayName: string }>;
  history?: HistoryRecord[];
}) {
  return {
    state: {
      cases: state?.cases ? state.cases.map((row) => ({ ...row })) : [],
      tasks: [],
      deals: state?.deals ? state.deals.map((row) => ({ ...row })) : [],
      companies: state?.companies ? state.companies.map((row) => ({ ...row })) : [],
      users: state?.users ? state.users.map((row) => ({ ...row })) : [],
      history: state?.history ? state.history.map((row) => ({ ...row })) : [],
      feedback: [],
    },
  };
}

describe("intervention analytics service", () => {
  it("aggregates summary, outcomes, hotspots, and breach queue", async () => {
    const now = new Date("2026-04-16T12:00:00.000Z");
    const tenantDb = createTenantDb({
      cases: [
        makeCase({
          id: "case-overdue-critical",
          severity: "critical",
          currentLifecycleStartedAt: new Date("2026-04-15T12:00:00.000Z"),
          assignedTo: "manager-1",
        }),
        makeCase({
          id: "case-overdue-high",
          businessKey: "office-1:stale_stage:deal:deal-2",
          scopeId: "deal-2",
          dealId: "deal-2",
          companyId: "company-1",
          disconnectType: "stale_stage",
          severity: "high",
          currentLifecycleStartedAt: new Date("2026-04-11T12:00:00.000Z"),
          assignedTo: "manager-1",
          escalated: true,
        }),
        makeCase({
          id: "case-open-normal",
          businessKey: "office-1:no_recent_contact:deal:deal-3",
          scopeId: "deal-3",
          dealId: "deal-3",
          companyId: "company-2",
          disconnectType: "no_recent_contact",
          severity: "medium",
          currentLifecycleStartedAt: new Date("2026-04-15T12:00:00.000Z"),
          assignedTo: "manager-2",
        }),
        makeCase({
          id: "case-repeat-open",
          businessKey: "office-1:missing_next_task:deal:deal-4",
          scopeId: "deal-4",
          dealId: "deal-4",
          companyId: "company-2",
          severity: "low",
          currentLifecycleStartedAt: new Date("2026-04-15T12:00:00.000Z"),
          assignedTo: null,
          reopenCount: 1,
        }),
        makeCase({
          id: "case-snooze-breached",
          businessKey: "office-1:missing_next_task:deal:deal-5",
          scopeId: "deal-5",
          dealId: "deal-5",
          companyId: "company-1",
          status: "snoozed",
          snoozedUntil: new Date("2026-04-15T09:00:00.000Z"),
          currentLifecycleStartedAt: new Date("2026-04-10T12:00:00.000Z"),
        }),
        makeCase({
          id: "case-resolved",
          businessKey: "office-1:missing_next_task:deal:deal-6",
          scopeId: "deal-6",
          dealId: "deal-6",
          companyId: "company-1",
          status: "resolved",
          resolvedAt: new Date("2026-04-15T12:00:00.000Z"),
          resolutionReason: "task_completed",
        }),
      ],
      deals: [
        { id: "deal-1", dealNumber: "D-1001", name: "Alpha Plaza", companyId: "company-1" },
        { id: "deal-2", dealNumber: "D-1002", name: "Beta Tower", companyId: "company-1" },
        { id: "deal-3", dealNumber: "D-1003", name: "Gamma Center", companyId: "company-2" },
        { id: "deal-4", dealNumber: "D-1004", name: "Delta Point", companyId: "company-2" },
        { id: "deal-5", dealNumber: "D-1005", name: "Epsilon Yard", companyId: "company-1" },
      ],
      companies: [
        { id: "company-1", name: "Acme Property Group" },
        { id: "company-2", name: "Beta Holdings" },
      ],
      users: [
        { id: "manager-1", displayName: "Manager One" },
        { id: "manager-2", displayName: "Manager Two" },
      ],
      history: [
        makeHistory({ id: "history-assign", disconnectCaseId: "case-overdue-critical", actionType: "assign" }),
        makeHistory({ id: "history-snooze", disconnectCaseId: "case-snooze-breached", actionType: "snooze" }),
        makeHistory({ id: "history-resolve", disconnectCaseId: "case-resolved", actionType: "resolve" }),
        makeHistory({ id: "history-escalate", disconnectCaseId: "case-overdue-high", actionType: "escalate" }),
      ],
    });

    const dashboard = await getInterventionAnalyticsDashboard(tenantDb as any, {
      officeId: "office-1",
      now,
    });

    expect(dashboard.summary).toMatchObject({
      openCases: 4,
      overdueCases: 2,
      escalatedCases: 1,
      snoozeOverdueCases: 1,
      repeatOpenCases: 1,
    });
    expect(dashboard.outcomes.actionVolume30d).toMatchObject({
      assign: 1,
      snooze: 1,
      resolve: 1,
      escalate: 1,
    });
    expect(dashboard.outcomes.clearanceRate30d).toBe(0.25);
    expect(dashboard.outcomes.reopenRate30d).toBe(0);
    expect(dashboard.hotspots.assignees[0]?.entityType).toBe("assignee");
    expect(dashboard.hotspots.assignees[0]?.label).toBe("Manager One");
    expect(dashboard.hotspots.assignees[0]?.queueLink).toContain("/admin/interventions?assigneeId=");
    expect(dashboard.breachQueue.items[0]?.detailLink).toContain("/admin/interventions");
    expect(dashboard.breachQueue.items.find((item) => item.caseId === "case-snooze-breached")).toMatchObject({
      detailLink: "/admin/interventions?view=snooze-breached&caseId=case-snooze-breached",
      queueLink: "/admin/interventions?view=snooze-breached&caseId=case-snooze-breached",
    });
    expect(dashboard.breachQueue.items[0]?.assignedTo).toBe("Manager One");
  });

  it("orders equal-severity breach rows with escalated cases first and returns null percentages when no denominator exists", async () => {
    const now = new Date("2026-04-16T12:00:00.000Z");
    const tenantDb = createTenantDb({
      cases: [
        makeCase({
          id: "case-escalated",
          severity: "high",
          escalated: true,
          currentLifecycleStartedAt: new Date("2026-04-11T12:00:00.000Z"),
        }),
        makeCase({
          id: "case-non-escalated",
          businessKey: "office-1:stale_stage:deal:deal-2",
          scopeId: "deal-2",
          dealId: "deal-2",
          severity: "high",
          currentLifecycleStartedAt: new Date("2026-04-11T12:00:00.000Z"),
        }),
      ],
      deals: [
        { id: "deal-1", dealNumber: "D-1001", name: "Alpha Plaza", companyId: "company-1" },
        { id: "deal-2", dealNumber: "D-1002", name: "Beta Tower", companyId: "company-1" },
      ],
      companies: [{ id: "company-1", name: "Acme Property Group" }],
      history: [],
    });

    const dashboard = await getInterventionAnalyticsDashboard(tenantDb as any, {
      officeId: "office-1",
      now,
    });

    expect(dashboard.breachQueue.items.slice(0, 2).map((item) => item.caseId)).toEqual([
      "case-escalated",
      "case-non-escalated",
    ]);
    expect(dashboard.outcomes.clearanceRate30d).toBeNull();
    expect(dashboard.outcomes.reopenRate30d).toBeNull();
  });

  it("filters hotspot rows that do not have any active open, overdue, or repeat case load", async () => {
    const now = new Date("2026-04-16T12:00:00.000Z");
    const tenantDb = createTenantDb({
      cases: [
        makeCase({
          id: "case-open",
          assignedTo: "manager-1",
        }),
        makeCase({
          id: "case-resolved-only",
          businessKey: "office-1:stale_stage:deal:deal-2",
          scopeId: "deal-2",
          dealId: "deal-2",
          disconnectType: "stale_stage",
          assignedTo: "manager-2",
          status: "resolved",
          resolvedAt: new Date("2026-04-15T12:00:00.000Z"),
        }),
      ],
      deals: [
        { id: "deal-1", dealNumber: "D-1001", name: "Alpha Plaza", companyId: "company-1" },
        { id: "deal-2", dealNumber: "D-1002", name: "Beta Tower", companyId: "company-1" },
      ],
      companies: [{ id: "company-1", name: "Acme Property Group" }],
      history: [],
    });

    const dashboard = await getInterventionAnalyticsDashboard(tenantDb as any, {
      officeId: "office-1",
      now,
    });

    expect(dashboard.hotspots.assignees.map((row) => row.label)).toEqual(["manager-1"]);
  });

  it("computes reopen rate by conclusion family from history events", async () => {
    const tenantDb = createTenantDb({
      cases: [
        makeCase({ id: "case-1", assignedTo: "manager-1" }),
        makeCase({
          id: "case-2",
          businessKey: "office-1:stale_stage:deal:deal-2",
          scopeId: "deal-2",
          dealId: "deal-2",
          disconnectType: "stale_stage",
          assignedTo: "manager-1",
        }),
      ],
      users: [{ id: "manager-1", displayName: "Manager One" }],
      history: [
        makeHistory({
          id: "resolve-1",
          disconnectCaseId: "case-1",
          actionType: "resolve",
          actedBy: "director-1",
          metadataJson: {
            assigneeAtConclusion: "manager-1",
            disconnectTypeAtConclusion: "missing_next_task",
            conclusion: {
              kind: "resolve",
              outcomeCategory: "owner_aligned",
            },
          },
        }),
        makeHistory({
          id: "resolve-2",
          disconnectCaseId: "case-2",
          actionType: "resolve",
          actedBy: "director-1",
          metadataJson: {
            assigneeAtConclusion: "manager-1",
            disconnectTypeAtConclusion: "stale_stage",
            conclusion: {
              kind: "resolve",
              outcomeCategory: "owner_aligned",
            },
          },
        }),
        makeHistory({
          id: "reopened-1",
          disconnectCaseId: "case-1",
          actionType: "reopened",
          actedBy: "system",
          metadataJson: {
            priorConclusionActionId: "resolve-1",
          },
        }),
      ],
    });

    const dashboard = await getInterventionAnalyticsDashboard(tenantDb as any, {
      officeId: "office-1",
    });

    expect(dashboard.outcomeEffectiveness.reopenRateByConclusionFamily.resolve).toBe(0.5);
    expect(dashboard.outcomeEffectiveness.conclusionMixByAssigneeAtConclusion[0]).toMatchObject({
      assigneeId: "manager-1",
      assigneeName: "Manager One",
      resolveCount: 2,
    });
  });
});
