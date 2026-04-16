import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SalesProcessDisconnectRow } from "../../../src/modules/ai-copilot/service.js";

const disconnectRowsMock = vi.fn<() => Promise<SalesProcessDisconnectRow[]>>();

vi.mock("../../../src/modules/ai-copilot/service.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/modules/ai-copilot/service.js")>(
    "../../../src/modules/ai-copilot/service.js"
  );

  return {
    ...actual,
    listCurrentSalesProcessDisconnectRows: disconnectRowsMock,
  };
});

const {
  materializeDisconnectCases,
  listInterventionCases,
  getInterventionCaseDetail,
  assignInterventionCases,
  snoozeInterventionCases,
  resolveInterventionCases,
  escalateInterventionCases,
} = await import("../../../src/modules/ai-copilot/intervention-service");

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
  lastIntervenedAt: Date | null;
  resolvedAt: Date | null;
  resolutionReason: string | null;
  metadataJson: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
};

type TaskRecord = {
  id: string;
  title: string;
  status: string;
  assignedTo: string;
  originRule: string | null;
  dedupeKey: string | null;
  dealId: string | null;
  officeId: string | null;
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

type FeedbackRecord = {
  id: string;
  targetType: string;
  targetId: string;
  userId: string;
  feedbackType: string;
  feedbackValue: string;
  comment: string | null;
  createdAt: Date;
};

function makeDisconnectRow(overrides: Partial<SalesProcessDisconnectRow> = {}): SalesProcessDisconnectRow {
  return {
    id: "deal-1",
    dealNumber: "D-1001",
    dealName: "Alpha Plaza",
    companyId: "company-1",
    companyName: "Acme Property Group",
    stageName: "Estimating",
    estimatingSubstage: "building_estimate",
    assignedRepName: "Rep One",
    disconnectType: "missing_next_task",
    disconnectLabel: "Missing next task",
    disconnectSeverity: "high",
    disconnectSummary: "Deal has no open next-step task.",
    disconnectDetails: "No pending or in-progress task exists to drive the next customer or internal step.",
    ageDays: 5,
    openTaskCount: 0,
    inboundWithoutFollowupCount: 0,
    lastActivityAt: "2026-04-10T10:00:00.000Z",
    latestCustomerEmailAt: null,
    proposalStatus: null,
    procoreSyncStatus: null,
    procoreSyncDirection: null,
    procoreLastSyncedAt: null,
    procoreSyncUpdatedAt: null,
    procoreDriftReason: null,
    ...overrides,
  };
}

function makeCase(
  overrides: Partial<DisconnectCaseRecord> = {},
  now = new Date("2026-04-16T15:00:00.000Z")
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
    assignedTo: null,
    generatedTaskId: null,
    escalated: false,
    snoozedUntil: null,
    reopenCount: 0,
    firstDetectedAt: now,
    lastDetectedAt: now,
    lastIntervenedAt: null,
    resolvedAt: null,
    resolutionReason: null,
    metadataJson: {
      evidenceSummary: "Deal has no open next-step task.",
      disconnectLabel: "Missing next task",
      disconnectSummary: "Deal has no open next-step task.",
      disconnectDetails: "No pending or in-progress task exists to drive the next customer or internal step.",
      dealName: "Alpha Plaza",
      dealNumber: "D-1001",
      companyName: "Acme Property Group",
      stageName: "Estimating",
      assignedRepName: "Rep One",
      ageDays: 5,
    },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "task-1",
    title: "Resolve Missing next task for D-1001",
    status: "pending",
    assignedTo: "user-1",
    originRule: "ai_disconnect_admin_task",
    dedupeKey: "office-1:missing_next_task:deal:deal-1",
    dealId: "deal-1",
    officeId: "office-1",
    ...overrides,
  };
}

function makeHistory(overrides: Partial<HistoryRecord> = {}): HistoryRecord {
  return {
    id: "history-1",
    disconnectCaseId: "case-1",
    actionType: "snooze",
    actedBy: "admin-1",
    actedAt: new Date("2026-04-15T13:00:00.000Z"),
    fromStatus: "open",
    toStatus: "snoozed",
    fromAssignee: null,
    toAssignee: null,
    fromSnoozedUntil: null,
    toSnoozedUntil: new Date("2026-04-20T00:00:00.000Z"),
    notes: null,
    metadataJson: null,
    ...overrides,
  };
}

function createTenantDb(state?: {
  cases?: DisconnectCaseRecord[];
  tasks?: TaskRecord[];
  deals?: DealRecord[];
  companies?: CompanyRecord[];
  history?: HistoryRecord[];
  feedback?: FeedbackRecord[];
}) {
  const internal = {
    cases: state?.cases ? state.cases.map((row) => ({ ...row })) : [],
    tasks: state?.tasks ? state.tasks.map((row) => ({ ...row })) : [],
    deals: state?.deals ? state.deals.map((row) => ({ ...row })) : [],
    companies: state?.companies ? state.companies.map((row) => ({ ...row })) : [],
    history: state?.history ? state.history.map((row) => ({ ...row })) : [],
    feedback: state?.feedback ? state.feedback.map((row) => ({ ...row })) : [],
  };

  return {
    state: internal,
  };
}

describe("AI intervention service", () => {
  beforeEach(() => {
    disconnectRowsMock.mockReset();
  });

  it("upserts one case per office_id + business_key", async () => {
    disconnectRowsMock
      .mockResolvedValueOnce([
        makeDisconnectRow(),
        makeDisconnectRow({ dealName: "Alpha Plaza Duplicate" }),
      ])
      .mockResolvedValueOnce([makeDisconnectRow({ disconnectSeverity: "critical" })]);

    const tenantDb = createTenantDb();
    const firstDetectedAt = new Date("2026-04-16T15:00:00.000Z");
    const secondDetectedAt = new Date("2026-04-16T16:00:00.000Z");

    await materializeDisconnectCases(tenantDb as any, {
      officeId: "office-1",
      now: firstDetectedAt,
    });

    await materializeDisconnectCases(tenantDb as any, {
      officeId: "office-1",
      now: secondDetectedAt,
    });

    expect(tenantDb.state.cases).toHaveLength(1);
    expect(tenantDb.state.cases[0]).toMatchObject({
      officeId: "office-1",
      businessKey: "office-1:missing_next_task:deal:deal-1",
      severity: "critical",
      lastDetectedAt: secondDetectedAt,
    });
    expect(tenantDb.state.cases[0]?.firstDetectedAt).toEqual(firstDetectedAt);
  });

  it("reopens a snoozed or resolved case on re-detection after the resolution or snooze window", async () => {
    disconnectRowsMock.mockResolvedValue([makeDisconnectRow()]);

    const tenantDb = createTenantDb({
      cases: [
        makeCase({
          status: "snoozed",
          snoozedUntil: new Date("2026-04-15T00:00:00.000Z"),
          lastIntervenedAt: new Date("2026-04-14T12:00:00.000Z"),
        }),
        makeCase({
          id: "case-2",
          businessKey: "office-1:stale_stage:deal:deal-2",
          scopeId: "deal-2",
          dealId: "deal-2",
          companyId: null,
          disconnectType: "stale_stage",
          clusterKey: "execution_stall",
          status: "resolved",
          resolvedAt: new Date("2026-04-14T00:00:00.000Z"),
          lastIntervenedAt: new Date("2026-04-14T00:00:00.000Z"),
          metadataJson: { evidenceSummary: "Deal has exceeded stale threshold." },
        }),
      ],
    });

    await materializeDisconnectCases(tenantDb as any, {
      officeId: "office-1",
      now: new Date("2026-04-16T15:00:00.000Z"),
    });

    expect(tenantDb.state.cases[0]).toMatchObject({
      status: "open",
      reopenCount: 1,
      snoozedUntil: null,
      resolvedAt: null,
    });

    disconnectRowsMock.mockResolvedValue([
      makeDisconnectRow({
        id: "deal-2",
        dealNumber: "D-1002",
        dealName: "Beta Tower",
        companyId: null,
        companyName: null,
        disconnectType: "stale_stage",
        disconnectLabel: "Stalled in stage",
        disconnectSeverity: "high",
        disconnectSummary: "Deal has exceeded its configured stale threshold.",
        disconnectDetails: "Estimating has been inactive for 8 days.",
      }),
    ]);

    await materializeDisconnectCases(tenantDb as any, {
      officeId: "office-1",
      now: new Date("2026-04-16T16:00:00.000Z"),
    });

    expect(tenantDb.state.cases[1]).toMatchObject({
      status: "open",
      reopenCount: 1,
      resolvedAt: null,
      resolutionReason: null,
    });
  });

  it("excludes snoozed cases from the default queue until snoozed_until", async () => {
    const tenantDb = createTenantDb({
      cases: [
        makeCase(),
        makeCase({
          id: "case-2",
          businessKey: "office-1:stale_stage:deal:deal-2",
          scopeId: "deal-2",
          dealId: "deal-2",
          companyId: null,
          disconnectType: "stale_stage",
          clusterKey: "execution_stall",
          status: "snoozed",
          snoozedUntil: new Date("2026-04-18T00:00:00.000Z"),
          metadataJson: { evidenceSummary: "Deal has exceeded stale threshold." },
        }),
      ],
      deals: [
        { id: "deal-1", dealNumber: "D-1001", name: "Alpha Plaza", companyId: "company-1" },
        { id: "deal-2", dealNumber: "D-1002", name: "Beta Tower", companyId: null },
      ],
      companies: [{ id: "company-1", name: "Acme Property Group" }],
    });

    const defaultQueue = await listInterventionCases(tenantDb as any, {
      officeId: "office-1",
      now: new Date("2026-04-16T15:00:00.000Z"),
    });

    expect(defaultQueue.items).toHaveLength(1);
    expect(defaultQueue.items[0]?.id).toBe("case-1");

    const snoozedQueue = await listInterventionCases(tenantDb as any, {
      officeId: "office-1",
      status: "snoozed",
      now: new Date("2026-04-16T15:00:00.000Z"),
    });

    expect(snoozedQueue.items).toHaveLength(1);
    expect(snoozedQueue.items[0]).toMatchObject({
      id: "case-2",
      status: "snoozed",
    });

    const afterWindow = await listInterventionCases(tenantDb as any, {
      officeId: "office-1",
      now: new Date("2026-04-19T15:00:00.000Z"),
    });

    expect(afterWindow.items.map((item) => item.id)).toEqual(["case-2", "case-1"]);
  });

  it("projects generated task state into queue rows", async () => {
    const tenantDb = createTenantDb({
      cases: [
        makeCase({
          generatedTaskId: "task-1",
          assignedTo: "manager-1",
        }),
      ],
      tasks: [
        makeTask({
          id: "task-1",
          status: "in_progress",
          assignedTo: "admin-2",
        }),
      ],
      deals: [{ id: "deal-1", dealNumber: "D-1001", name: "Alpha Plaza", companyId: "company-1" }],
      companies: [{ id: "company-1", name: "Acme Property Group" }],
      history: [
        makeHistory({
          actionType: "assign",
          actedAt: new Date("2026-04-16T14:00:00.000Z"),
        }),
      ],
    });

    const queue = await listInterventionCases(tenantDb as any, {
      officeId: "office-1",
      now: new Date("2026-04-16T15:00:00.000Z"),
    });

    expect(queue.items).toEqual([
      expect.objectContaining({
        id: "case-1",
        assignedTo: "manager-1",
        generatedTask: {
          id: "task-1",
          status: "in_progress",
          assignedTo: "admin-2",
          title: "Resolve Missing next task for D-1001",
        },
        deal: {
          id: "deal-1",
          dealNumber: "D-1001",
          name: "Alpha Plaza",
        },
        company: {
          id: "company-1",
          name: "Acme Property Group",
        },
        evidenceSummary: "Deal has no open next-step task.",
        lastIntervention: {
          actionType: "assign",
          actedAt: "2026-04-16T14:00:00.000Z",
        },
      }),
    ]);
  });

  it("loads case detail with linked task, CRM context, and recent history", async () => {
    const tenantDb = createTenantDb({
      cases: [
        makeCase({
          generatedTaskId: "task-1",
          assignedTo: "manager-1",
        }),
      ],
      tasks: [makeTask()],
      deals: [{ id: "deal-1", dealNumber: "D-1001", name: "Alpha Plaza", companyId: "company-1" }],
      companies: [{ id: "company-1", name: "Acme Property Group" }],
      history: [
        makeHistory({
          id: "history-2",
          actionType: "resolve",
          actedAt: new Date("2026-04-16T10:00:00.000Z"),
        }),
        makeHistory({
          id: "history-1",
          actionType: "assign",
          actedAt: new Date("2026-04-16T14:00:00.000Z"),
        }),
      ],
    });

    const detail = await getInterventionCaseDetail(tenantDb as any, {
      officeId: "office-1",
      caseId: "case-1",
    });

    expect(detail).toMatchObject({
      case: {
        id: "case-1",
        businessKey: "office-1:missing_next_task:deal:deal-1",
      },
      generatedTask: {
        id: "task-1",
        status: "pending",
      },
      crm: {
        deal: {
          id: "deal-1",
          dealNumber: "D-1001",
          name: "Alpha Plaza",
        },
        company: {
          id: "company-1",
          name: "Acme Property Group",
        },
      },
    });
    expect(detail.history.map((entry) => entry.id)).toEqual(["history-1", "history-2"]);
  });

  it("assigns intervention cases and syncs generated task assignees", async () => {
    const tenantDb = createTenantDb({
      cases: [
        makeCase({
          generatedTaskId: "task-1",
          assignedTo: "manager-1",
        }),
      ],
      tasks: [
        makeTask({
          id: "task-1",
          assignedTo: "manager-1",
          status: "pending",
        }),
      ],
    });

    const result = await assignInterventionCases(tenantDb as any, {
      officeId: "office-1",
      actorUserId: "director-1",
      actorRole: "director",
      caseIds: ["case-1"],
      assignedTo: "manager-2",
      notes: "Reassign to closer owner",
    });

    expect(result).toEqual({
      updatedCount: 1,
      skippedCount: 0,
      errors: [],
    });
    expect(tenantDb.state.cases[0]).toMatchObject({
      assignedTo: "manager-2",
      status: "open",
    });
    expect(tenantDb.state.tasks[0]).toMatchObject({
      assignedTo: "manager-2",
      status: "pending",
    });
    expect(tenantDb.state.history).toHaveLength(1);
    expect(tenantDb.state.history[0]).toMatchObject({
      disconnectCaseId: "case-1",
      actionType: "assign",
      actedBy: "director-1",
      fromAssignee: "manager-1",
      toAssignee: "manager-2",
      notes: "Reassign to closer owner",
    });
    expect(tenantDb.state.feedback).toHaveLength(1);
    expect(tenantDb.state.feedback[0]).toMatchObject({
      targetType: "disconnect_case",
      targetId: "case-1",
      userId: "director-1",
      feedbackType: "intervention_action",
      feedbackValue: "assign",
    });
  });

  it("assigns intervention cases without editing generated tasks that are already completed", async () => {
    const tenantDb = createTenantDb({
      cases: [
        makeCase({
          generatedTaskId: "task-1",
          assignedTo: null,
        }),
      ],
      tasks: [
        makeTask({
          id: "task-1",
          assignedTo: "manager-1",
          status: "completed",
        }),
      ],
    });

    const result = await assignInterventionCases(tenantDb as any, {
      officeId: "office-1",
      actorUserId: "director-1",
      actorRole: "director",
      caseIds: ["case-1"],
      assignedTo: "manager-2",
      notes: "Reassign case only",
    });

    expect(result).toEqual({
      updatedCount: 1,
      skippedCount: 0,
      errors: [],
    });
    expect(tenantDb.state.cases[0]).toMatchObject({
      assignedTo: "manager-2",
      status: "open",
    });
    expect(tenantDb.state.tasks[0]).toMatchObject({
      assignedTo: "manager-1",
      status: "completed",
    });
    expect(tenantDb.state.history[0]).toMatchObject({
      actionType: "assign",
      fromAssignee: null,
      toAssignee: "manager-2",
    });
  });

  it("filters intervention queue by workspace view and cluster key before pagination", async () => {
    const tenantDb = createTenantDb({
      cases: [
        makeCase({
          id: "case-1",
          clusterKey: "follow_through_gap",
          metadataJson: { evidenceSummary: "Aging queue case", ageDays: 9 },
        }),
        makeCase({
          id: "case-2",
          businessKey: "office-1:stale_stage:deal:deal-2",
          scopeId: "deal-2",
          dealId: "deal-2",
          disconnectType: "stale_stage",
          clusterKey: "execution_stall",
          metadataJson: { evidenceSummary: "Wrong cluster", ageDays: 12 },
        }),
        makeCase({
          id: "case-3",
          businessKey: "office-1:missing_next_task:deal:deal-3",
          scopeId: "deal-3",
          dealId: "deal-3",
          clusterKey: "follow_through_gap",
          metadataJson: { evidenceSummary: "Too new", ageDays: 2 },
        }),
      ],
    });

    const result = await listInterventionCases(tenantDb as any, {
      officeId: "office-1",
      view: "aging",
      clusterKey: "follow_through_gap",
      page: 1,
      pageSize: 50,
    });

    expect(result.totalCount).toBe(1);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.id).toBe("case-1");
  });

  it("snoozes intervention cases, syncs generated tasks, and writes history plus feedback", async () => {
    const tenantDb = createTenantDb({
      cases: [
        makeCase({
          generatedTaskId: "task-1",
          assignedTo: "manager-1",
        }),
      ],
      tasks: [
        makeTask({
          id: "task-1",
          assignedTo: "manager-1",
          status: "in_progress",
        }),
      ],
    });

    const result = await snoozeInterventionCases(tenantDb as any, {
      officeId: "office-1",
      actorUserId: "director-1",
      actorRole: "director",
      caseIds: ["case-1"],
      snoozedUntil: "2026-04-20T00:00:00.000Z",
      notes: "Waiting on customer reply",
    });

    expect(result).toEqual({
      updatedCount: 1,
      skippedCount: 0,
      errors: [],
    });
    expect(tenantDb.state.cases[0]).toMatchObject({
      status: "snoozed",
      snoozedUntil: new Date("2026-04-20T00:00:00.000Z"),
    });
    expect(tenantDb.state.tasks[0]).toMatchObject({
      status: "in_progress",
      dueDate: "2026-04-20",
    });
    expect(tenantDb.state.history[0]).toMatchObject({
      actionType: "snooze",
      fromStatus: "open",
      toStatus: "snoozed",
      toSnoozedUntil: new Date("2026-04-20T00:00:00.000Z"),
    });
    expect(tenantDb.state.feedback[0]).toMatchObject({
      feedbackType: "intervention_action",
      feedbackValue: "snooze",
    });
  });

  it("snoozes intervention cases without editing generated tasks that are already completed", async () => {
    const tenantDb = createTenantDb({
      cases: [
        makeCase({
          generatedTaskId: "task-1",
        }),
      ],
      tasks: [
        makeTask({
          id: "task-1",
          assignedTo: "manager-1",
          status: "completed",
        }),
      ],
    });

    const result = await snoozeInterventionCases(tenantDb as any, {
      officeId: "office-1",
      actorUserId: "director-1",
      actorRole: "director",
      caseIds: ["case-1"],
      snoozedUntil: "2026-04-20T00:00:00.000Z",
      notes: "Snooze case only",
    });

    expect(result).toEqual({
      updatedCount: 1,
      skippedCount: 0,
      errors: [],
    });
    expect(tenantDb.state.cases[0]).toMatchObject({
      status: "snoozed",
      snoozedUntil: new Date("2026-04-20T00:00:00.000Z"),
    });
    expect(tenantDb.state.tasks[0]).toMatchObject({
      status: "completed",
    });
    expect(tenantDb.state.tasks[0]?.dueDate ?? null).toBeNull();
  });

  it("resolves intervention cases, maps generated task outcomes, and writes history plus feedback", async () => {
    const tenantDb = createTenantDb({
      cases: [
        makeCase({
          generatedTaskId: "task-1",
          assignedTo: "manager-1",
        }),
        makeCase({
          id: "case-2",
          generatedTaskId: "task-2",
          businessKey: "office-1:stale_stage:deal:deal-2",
          scopeId: "deal-2",
          dealId: "deal-2",
          companyId: null,
          disconnectType: "stale_stage",
          clusterKey: "execution_stall",
          metadataJson: { evidenceSummary: "Deal has exceeded stale threshold." },
        }),
      ],
      tasks: [
        makeTask({ id: "task-1", status: "pending" }),
        makeTask({
          id: "task-2",
          dealId: "deal-2",
          dedupeKey: "office-1:stale_stage:deal:deal-2",
          status: "pending",
        }),
      ],
    });

    const completedResult = await resolveInterventionCases(tenantDb as any, {
      officeId: "office-1",
      actorUserId: "director-1",
      actorRole: "director",
      caseIds: ["case-1"],
      resolutionReason: "task_completed",
      notes: "The task was completed directly",
    });

    expect(completedResult).toEqual({
      updatedCount: 1,
      skippedCount: 0,
      errors: [],
    });
    expect(tenantDb.state.cases[0]).toMatchObject({
      status: "resolved",
      resolutionReason: "task_completed",
    });
    expect(tenantDb.state.tasks[0]).toMatchObject({
      status: "completed",
    });

    const dismissedResult = await resolveInterventionCases(tenantDb as any, {
      officeId: "office-1",
      actorUserId: "director-1",
      actorRole: "director",
      caseIds: ["case-2"],
      resolutionReason: "owner_aligned",
      notes: "No further admin task is needed",
    });

    expect(dismissedResult).toEqual({
      updatedCount: 1,
      skippedCount: 0,
      errors: [],
    });
    expect(tenantDb.state.cases[1]).toMatchObject({
      status: "resolved",
      resolutionReason: "owner_aligned",
    });
    expect(tenantDb.state.tasks[1]).toMatchObject({
      status: "dismissed",
    });
    expect(tenantDb.state.history).toHaveLength(2);
    expect(tenantDb.state.history[0]).toMatchObject({
      disconnectCaseId: "case-1",
      actionType: "resolve",
      fromStatus: "open",
      toStatus: "resolved",
      notes: "The task was completed directly",
      metadataJson: { resolutionReason: "task_completed", taskOutcome: "completed" },
    });
    expect(tenantDb.state.history[1]).toMatchObject({
      disconnectCaseId: "case-2",
      actionType: "resolve",
      metadataJson: { resolutionReason: "owner_aligned", taskOutcome: "dismissed" },
    });
    expect(tenantDb.state.feedback).toHaveLength(2);
    expect(tenantDb.state.feedback[0]).toMatchObject({
      feedbackValue: "resolve",
    });
    expect(tenantDb.state.feedback[1]).toMatchObject({
      feedbackValue: "resolve",
    });
  });

  it("escalates intervention cases and writes history plus feedback", async () => {
    const tenantDb = createTenantDb({
      cases: [
        makeCase({
          generatedTaskId: "task-1",
          escalated: false,
        }),
      ],
      tasks: [makeTask({ id: "task-1", status: "pending" })],
    });

    const result = await escalateInterventionCases(tenantDb as any, {
      officeId: "office-1",
      actorUserId: "director-1",
      actorRole: "director",
      caseIds: ["case-1"],
      notes: "Escalate for leadership attention",
    });

    expect(result).toEqual({
      updatedCount: 1,
      skippedCount: 0,
      errors: [],
    });
    expect(tenantDb.state.cases[0]).toMatchObject({
      escalated: true,
      status: "open",
    });
    expect(tenantDb.state.history[0]).toMatchObject({
      actionType: "escalate",
      notes: "Escalate for leadership attention",
      metadataJson: { escalated: true },
    });
    expect(tenantDb.state.feedback[0]).toMatchObject({
      feedbackType: "intervention_action",
      feedbackValue: "escalate",
    });
  });
});
