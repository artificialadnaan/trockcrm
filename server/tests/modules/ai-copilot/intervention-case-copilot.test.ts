import { describe, expect, it } from "vitest";

const { buildInterventionCopilotView } = await import("../../../src/modules/ai-copilot/intervention-service");

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

type UserRecord = {
  id: string;
  displayName: string;
};

type TaskRecord = {
  id: string;
  title: string;
  status: string;
  assignedTo: string;
};

type PacketRecord = {
  id: string;
  scopeType: string;
  scopeId: string;
  dealId: string | null;
  packetKind: string;
  snapshotHash: string;
  modelName: string | null;
  status: string;
  summaryText: string | null;
  nextStepJson: Record<string, unknown> | null;
  blindSpotsJson: Array<Record<string, unknown>> | null;
  evidenceJson: Array<Record<string, unknown>> | null;
  confidence: string | null;
  generatedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
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

function makeCase(overrides: Partial<DisconnectCaseRecord> = {}): DisconnectCaseRecord {
  return {
    id: "00000000-0000-0000-0000-000000000101",
    officeId: "00000000-0000-0000-0000-000000000001",
    scopeType: "deal",
    scopeId: "00000000-0000-0000-0000-000000000201",
    dealId: "00000000-0000-0000-0000-000000000201",
    companyId: "00000000-0000-0000-0000-000000000301",
    disconnectType: "missing_next_task",
    clusterKey: "follow_through_gap",
    businessKey: "office-1:missing_next_task:deal:deal-1",
    severity: "high",
    status: "open",
    assignedTo: "00000000-0000-0000-0000-000000000401",
    generatedTaskId: null,
    escalated: false,
    snoozedUntil: null,
    reopenCount: 0,
    firstDetectedAt: new Date("2026-04-18T12:00:00.000Z"),
    lastDetectedAt: new Date("2026-04-19T12:00:00.000Z"),
    currentLifecycleStartedAt: new Date("2026-04-18T12:00:00.000Z"),
    lastReopenedAt: null,
    lastIntervenedAt: null,
    resolvedAt: null,
    resolutionReason: null,
    metadataJson: {
      stageKey: "estimating",
      stageName: "Estimating",
      assignedRepName: "Rep One",
    },
    createdAt: new Date("2026-04-18T12:00:00.000Z"),
    updatedAt: new Date("2026-04-19T12:00:00.000Z"),
    ...overrides,
  };
}

function makeHistory(overrides: Partial<HistoryRecord> = {}): HistoryRecord {
  return {
    id: "00000000-0000-0000-0000-000000000501",
    disconnectCaseId: "00000000-0000-0000-0000-000000000101",
    actionType: "resolve",
    actedBy: "00000000-0000-0000-0000-000000000402",
    actedAt: new Date("2026-04-19T12:00:00.000Z"),
    fromStatus: "open",
    toStatus: "resolved",
    fromAssignee: null,
    toAssignee: "00000000-0000-0000-0000-000000000401",
    fromSnoozedUntil: null,
    toSnoozedUntil: null,
    notes: null,
    metadataJson: null,
    ...overrides,
  };
}

function makePacket(overrides: Partial<PacketRecord> = {}): PacketRecord {
  return {
    id: "00000000-0000-0000-0000-000000000601",
    scopeType: "intervention_case",
    scopeId: "00000000-0000-0000-0000-000000000101",
    dealId: "00000000-0000-0000-0000-000000000201",
    packetKind: "intervention_case",
    snapshotHash: "hash-1",
    modelName: "heuristic",
    status: "ready",
    summaryText: "This case likely needs owner alignment before a resolve attempt.",
    nextStepJson: {
      action: "assign",
      rationale: "The generated task is unowned while the case is already high severity.",
      suggestedOwner: "Admin User",
      suggestedOwnerId: "00000000-0000-0000-0000-000000000401",
    },
    blindSpotsJson: [
      {
        flagType: "reopen_risk",
        severity: "medium",
        title: "Repeat-open pattern",
        details: "Similar cases reopened after weak snoozes.",
      },
    ],
    evidenceJson: [
      {
        sourceType: "case_history",
        textSnippet: "resolved once, reopened later",
        label: "Prior case history",
      },
    ],
    confidence: "0.7800",
    generatedAt: new Date("2026-04-19T12:00:00.000Z"),
    expiresAt: new Date("2026-04-19T12:30:00.000Z"),
    createdAt: new Date("2026-04-19T12:00:00.000Z"),
    updatedAt: new Date("2026-04-19T12:00:00.000Z"),
    ...overrides,
  };
}

function makeFeedback(overrides: Partial<FeedbackRecord> = {}): FeedbackRecord {
  return {
    id: "00000000-0000-0000-0000-000000000701",
    targetType: "packet",
    targetId: "00000000-0000-0000-0000-000000000601",
    userId: "00000000-0000-0000-0000-000000000403",
    feedbackType: "intervention_case_copilot",
    feedbackValue: "useful",
    comment: null,
    createdAt: new Date("2026-04-19T12:10:00.000Z"),
    ...overrides,
  };
}

function createTenantDb(state: {
  cases: DisconnectCaseRecord[];
  history: HistoryRecord[];
  tasks?: TaskRecord[];
  users?: UserRecord[];
  packets?: PacketRecord[];
  feedback?: FeedbackRecord[];
}) {
  return {
    state: {
      cases: state.cases,
      tasks: state.tasks ?? [],
      deals: [],
      companies: [],
      users: state.users ?? [],
      history: state.history,
      packets: state.packets ?? [],
      feedback: state.feedback ?? [],
    },
  } as any;
}

describe("buildInterventionCopilotView", () => {
  it("returns a normalized intervention copilot view with packet, evidence, freshness, and similar cases", async () => {
    const tenantDb = createTenantDb({
      cases: [
        makeCase({
          id: "00000000-0000-0000-0000-000000000101",
          officeId: "00000000-0000-0000-0000-000000000001",
          assignedTo: "00000000-0000-0000-0000-000000000401",
          generatedTaskId: "00000000-0000-0000-0000-000000000801",
          reopenCount: 1,
        }),
        makeCase({
          id: "00000000-0000-0000-0000-000000000102",
          officeId: "00000000-0000-0000-0000-000000000001",
          businessKey: "office-1:missing_next_task:deal:deal-2",
          scopeId: "00000000-0000-0000-0000-000000000202",
          dealId: "00000000-0000-0000-0000-000000000202",
          status: "resolved",
          resolvedAt: new Date("2026-04-19T12:00:00.000Z"),
          assignedTo: "00000000-0000-0000-0000-000000000499",
        }),
      ],
      history: [
        makeHistory({
          disconnectCaseId: "00000000-0000-0000-0000-000000000102",
          actionType: "resolve",
          metadataJson: {
            conclusion: { kind: "resolve", reasonCode: "follow_up_completed" },
            assigneeAtConclusion: "00000000-0000-0000-0000-000000000401",
          },
        }),
      ],
      tasks: [
        {
          id: "00000000-0000-0000-0000-000000000801",
          title: "Follow up with customer",
          status: "pending",
          assignedTo: "00000000-0000-0000-0000-000000000402",
        },
      ],
      users: [
        { id: "00000000-0000-0000-0000-000000000401", displayName: "Admin User" },
        { id: "00000000-0000-0000-0000-000000000402", displayName: "Director User" },
        { id: "00000000-0000-0000-0000-000000000499", displayName: "Later Owner" },
      ],
      packets: [makePacket()],
      feedback: [makeFeedback()],
    });

    const view = await buildInterventionCopilotView(tenantDb, {
      caseId: "00000000-0000-0000-0000-000000000101",
      officeId: "00000000-0000-0000-0000-000000000001",
      viewerUserId: "00000000-0000-0000-0000-000000000403",
    });

    expect(view.packet.id).toBe("00000000-0000-0000-0000-000000000601");
    expect(view.recommendedAction?.action).toBe("assign");
    expect(view.currentAssignee).toEqual({
      id: "00000000-0000-0000-0000-000000000401",
      name: "Admin User",
    });
    expect(view.blockerOwner).toEqual({
      id: "00000000-0000-0000-0000-000000000402",
      name: null,
    });
    expect(view.evidence).toMatchObject([
      {
        label: "Prior case history",
        textSnippet: "resolved once, reopened later",
        sourceType: "case_history",
      },
    ]);
    expect(view.riskFlags.map((flag) => flag.flagType)).toEqual(
      expect.arrayContaining(["reopen_risk", "owner_mismatch"])
    );
    expect(view.similarCases).toHaveLength(1);
    expect(view.similarCases[0]).toMatchObject({
      caseId: "00000000-0000-0000-0000-000000000102",
      assigneeAtConclusion: "00000000-0000-0000-0000-000000000401",
      conclusionKind: "resolve",
      reasonCode: "follow_up_completed",
    });
    expect(view.isStale).toBe(false);
    expect(view.viewerFeedbackValue).toBe("useful");
  });

  it("excludes the current case and other-office cases from similar-case matches and returns an empty packet shell", async () => {
    const tenantDb = createTenantDb({
      cases: [
        makeCase({
          id: "00000000-0000-0000-0000-000000000101",
          officeId: "00000000-0000-0000-0000-000000000001",
        }),
        makeCase({
          id: "00000000-0000-0000-0000-000000000103",
          officeId: "00000000-0000-0000-0000-000000000002",
          businessKey: "office-2:missing_next_task:deal:deal-3",
          scopeId: "00000000-0000-0000-0000-000000000203",
          dealId: "00000000-0000-0000-0000-000000000203",
          status: "resolved",
        }),
      ],
      history: [
        makeHistory({
          disconnectCaseId: "00000000-0000-0000-0000-000000000103",
          actionType: "resolve",
        }),
      ],
    });

    const view = await buildInterventionCopilotView(tenantDb, {
      caseId: "00000000-0000-0000-0000-000000000101",
      officeId: "00000000-0000-0000-0000-000000000001",
      viewerUserId: "00000000-0000-0000-0000-000000000403",
    });

    expect(view.packet).toMatchObject({
      id: null,
      summaryText: null,
      confidence: null,
      generatedAt: null,
    });
    expect(view.evidence).toHaveLength(3);
    expect(view.similarCases).toEqual([]);
  });

  it("prefers a resolve recommendation for resolved cases even when a generated task is still linked", async () => {
    const tenantDb = createTenantDb({
      cases: [
        makeCase({
          id: "00000000-0000-0000-0000-000000000101",
          officeId: "00000000-0000-0000-0000-000000000001",
          status: "resolved",
          resolvedAt: new Date("2026-04-19T12:05:00.000Z"),
          assignedTo: null,
          generatedTaskId: "00000000-0000-0000-0000-000000000801",
        }),
      ],
      history: [
        makeHistory({
          disconnectCaseId: "00000000-0000-0000-0000-000000000101",
          actionType: "resolve",
        }),
      ],
      tasks: [
        {
          id: "00000000-0000-0000-0000-000000000801",
          title: "Stale linked task",
          status: "pending",
          assignedTo: "00000000-0000-0000-0000-000000000402",
        },
      ],
      packets: [
        makePacket({
          nextStepJson: {
            action: "assign",
            rationale: "Stale packet still wants reassignment.",
            suggestedOwner: "Director User",
            suggestedOwnerId: "00000000-0000-0000-0000-000000000402",
          },
        }),
      ],
    });

    const view = await buildInterventionCopilotView(tenantDb, {
      caseId: "00000000-0000-0000-0000-000000000101",
      officeId: "00000000-0000-0000-0000-000000000001",
      viewerUserId: "00000000-0000-0000-0000-000000000403",
    });

    expect(view.recommendedAction?.action).toBe("resolve");
  });

  it("treats a snooze deadline equal to now as breached", async () => {
    const now = new Date("2026-04-19T12:00:00.000Z");
    const tenantDb = createTenantDb({
      cases: [
        makeCase({
          id: "00000000-0000-0000-0000-000000000101",
          officeId: "00000000-0000-0000-0000-000000000001",
          status: "snoozed",
          snoozedUntil: new Date("2026-04-19T12:00:00.000Z"),
        }),
      ],
      history: [
        makeHistory({
          disconnectCaseId: "00000000-0000-0000-0000-000000000101",
          actionType: "snooze",
          metadataJson: {
            conclusion: { kind: "snooze", snoozeReasonCode: "waiting_on_customer" },
          },
        }),
      ],
    });

    const view = await buildInterventionCopilotView(tenantDb, {
      caseId: "00000000-0000-0000-0000-000000000101",
      officeId: "00000000-0000-0000-0000-000000000001",
      viewerUserId: "00000000-0000-0000-0000-000000000403",
      now,
    });

    expect(view.riskFlags.map((flag) => flag.flagType)).toEqual(
      expect.arrayContaining(["snooze_breach"])
    );
    expect(view.reopenRisk?.level).toBe("high");
  });
});
