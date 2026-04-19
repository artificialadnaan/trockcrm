import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../../../src/middleware/error-handler.js";

const serviceMocks = vi.hoisted(() => ({
  getAiActionQueue: vi.fn(),
  getSalesProcessDisconnectDashboard: vi.fn(),
  getCompanyCopilotView: vi.fn(),
  getDealCopilotView: vi.fn(),
  dismissTaskSuggestion: vi.fn(),
  getAiReviewPacketDetail: vi.fn(),
  recordAiFeedback: vi.fn(),
  getDirectorBlindSpots: vi.fn(),
  getAiOpsMetrics: vi.fn(),
  getAiReviewQueue: vi.fn(),
  triageAiActionQueueEntry: vi.fn(),
}));

const interventionServiceMocks = vi.hoisted(() => ({
  listInterventionCases: vi.fn(),
  getInterventionAnalyticsDashboard: vi.fn(),
  getLatestManagerAlertSnapshot: vi.fn(),
  runManagerAlertPreview: vi.fn(),
  sendManagerAlertSummary: vi.fn(),
  getInterventionCaseDetail: vi.fn(),
  buildInterventionCopilotView: vi.fn(),
  regenerateInterventionCopilot: vi.fn(),
  assignInterventionCases: vi.fn(),
  assertHomogeneousBatchConclusionCohort: vi.fn(),
  snoozeInterventionCases: vi.fn(),
  resolveInterventionCases: vi.fn(),
  escalateInterventionCases: vi.fn(),
}));

const taskSuggestionMocks = vi.hoisted(() => ({
  acceptTaskSuggestion: vi.fn(),
}));

const dealsServiceMocks = vi.hoisted(() => ({
  getDealById: vi.fn(),
}));

const companiesServiceMocks = vi.hoisted(() => ({
  getCompanyById: vi.fn(),
}));

vi.mock("../../../src/modules/ai-copilot/service.js", () => ({
  getAiActionQueue: serviceMocks.getAiActionQueue,
  getSalesProcessDisconnectDashboard: serviceMocks.getSalesProcessDisconnectDashboard,
  getCompanyCopilotView: serviceMocks.getCompanyCopilotView,
  getDealCopilotView: serviceMocks.getDealCopilotView,
  dismissTaskSuggestion: serviceMocks.dismissTaskSuggestion,
  getAiReviewPacketDetail: serviceMocks.getAiReviewPacketDetail,
  recordAiFeedback: serviceMocks.recordAiFeedback,
  getDirectorBlindSpots: serviceMocks.getDirectorBlindSpots,
  getAiOpsMetrics: serviceMocks.getAiOpsMetrics,
  getAiReviewQueue: serviceMocks.getAiReviewQueue,
  triageAiActionQueueEntry: serviceMocks.triageAiActionQueueEntry,
}));

vi.mock("../../../src/modules/ai-copilot/intervention-service.js", () => ({
  listInterventionCases: interventionServiceMocks.listInterventionCases,
  getInterventionAnalyticsDashboard: interventionServiceMocks.getInterventionAnalyticsDashboard,
  getInterventionCaseDetail: interventionServiceMocks.getInterventionCaseDetail,
  buildInterventionCopilotView: interventionServiceMocks.buildInterventionCopilotView,
  regenerateInterventionCopilot: interventionServiceMocks.regenerateInterventionCopilot,
  assignInterventionCases: interventionServiceMocks.assignInterventionCases,
  assertHomogeneousBatchConclusionCohort: interventionServiceMocks.assertHomogeneousBatchConclusionCohort,
  snoozeInterventionCases: interventionServiceMocks.snoozeInterventionCases,
  resolveInterventionCases: interventionServiceMocks.resolveInterventionCases,
  escalateInterventionCases: interventionServiceMocks.escalateInterventionCases,
}));

vi.mock("../../../src/modules/ai-copilot/intervention-manager-alerts-service.js", () => ({
  getLatestManagerAlertSnapshot: interventionServiceMocks.getLatestManagerAlertSnapshot,
  runManagerAlertPreview: interventionServiceMocks.runManagerAlertPreview,
  sendManagerAlertSummary: interventionServiceMocks.sendManagerAlertSummary,
}));

vi.mock("../../../src/modules/ai-copilot/task-suggestion-service.js", () => ({
  acceptTaskSuggestion: taskSuggestionMocks.acceptTaskSuggestion,
}));

vi.mock("../../../src/modules/deals/service.js", () => ({
  getDealById: dealsServiceMocks.getDealById,
}));

vi.mock("../../../src/modules/companies/service.js", () => ({
  getCompanyById: companiesServiceMocks.getCompanyById,
}));

const { aiCopilotRoutes } = await import("../../../src/modules/ai-copilot/routes.js");
const { errorHandler } = await import("../../../src/middleware/error-handler.js");
let insertMock: ReturnType<typeof vi.fn>;
let selectMock: ReturnType<typeof vi.fn>;
let executeMock: ReturnType<typeof vi.fn>;

function createApp(role: "admin" | "director" | "rep" = "rep") {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = {
      id: `${role}-1`,
      email: `${role}@example.com`,
      displayName: `${role} user`,
      role,
      officeId: "office-1",
      activeOfficeId: "office-1",
    };
    req.tenantDb = { insert: insertMock, select: selectMock, execute: executeMock } as any;
    req.commitTransaction = vi.fn().mockResolvedValue(undefined);
    next();
  });
  app.use("/api/ai", aiCopilotRoutes);
  app.use(errorHandler);
  return app;
}

describe("ai copilot routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.ALLOW_LEGACY_OUTCOME_WRITES;
    insertMock = vi.fn(() => ({
      values: vi.fn().mockResolvedValue(undefined),
    }));
    selectMock = vi.fn(() => ({
      from: vi.fn().mockResolvedValue([]),
    }));
    executeMock = vi.fn().mockResolvedValue(undefined);
    dealsServiceMocks.getDealById.mockResolvedValue({
      id: "deal-1",
      assignedRepId: "rep-1",
    });
    companiesServiceMocks.getCompanyById.mockResolvedValue({
      id: "company-1",
      name: "Acme Property Group",
    });
  });

  it("returns the deal copilot packet view", async () => {
    serviceMocks.getDealCopilotView.mockResolvedValue({
      packet: { id: "packet-1", summary: "Deal needs follow-up." },
      suggestedTasks: [],
      blindSpotFlags: [],
    });

    const app = createApp("rep");
    const res = await request(app).get("/api/ai/deals/deal-1/copilot");

    expect(res.status).toBe(200);
    expect(serviceMocks.getDealCopilotView).toHaveBeenCalledWith(expect.anything(), "deal-1");
    expect(res.body.packet.summary).toBe("Deal needs follow-up.");
  });

  it("returns the company copilot aggregate view", async () => {
    serviceMocks.getCompanyCopilotView.mockResolvedValue({
      company: { id: "company-1", name: "Acme Property Group", contactCount: 3, dealCount: 2 },
      summaryText: "Acme Property Group has 2 active deals.",
      relatedDeals: [],
      suggestedTasks: [],
      blindSpotFlags: [],
    });

    const app = createApp("rep");
    const res = await request(app).get("/api/ai/companies/company-1/copilot");

    expect(res.status).toBe(200);
    expect(serviceMocks.getCompanyCopilotView).toHaveBeenCalledWith(expect.anything(), {
      id: "company-1",
      name: "Acme Property Group",
    });
    expect(res.body.company.name).toBe("Acme Property Group");
  });

  it("queues a background deal copilot regeneration", async () => {
    const app = createApp("rep");
    const res = await request(app).post("/api/ai/deals/deal-1/regenerate");

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ queued: true });
    expect(insertMock).toHaveBeenCalledTimes(1);
  });

  it("accepts a suggested task and creates a real task", async () => {
    taskSuggestionMocks.acceptTaskSuggestion.mockResolvedValue({
      suggestionId: "suggestion-1",
      acceptedTaskId: "task-1",
      status: "accepted",
    });

    const app = createApp("rep");
    const res = await request(app)
      .post("/api/ai/task-suggestions/suggestion-1/accept");

    expect(res.status).toBe(200);
    expect(taskSuggestionMocks.acceptTaskSuggestion).toHaveBeenCalledWith(
      expect.anything(),
      "suggestion-1",
      "rep-1"
    );
    expect(res.body.acceptedTaskId).toBe("task-1");
  });

  it("dismisses a suggested task", async () => {
    serviceMocks.dismissTaskSuggestion.mockResolvedValue({
      suggestionId: "suggestion-1",
      status: "dismissed",
    });

    const app = createApp("rep");
    const res = await request(app)
      .post("/api/ai/task-suggestions/suggestion-1/dismiss");

    expect(res.status).toBe(200);
    expect(serviceMocks.dismissTaskSuggestion).toHaveBeenCalledWith(
      expect.anything(),
      "suggestion-1",
      "rep-1"
    );
  });

  it("records user feedback for ai output", async () => {
    serviceMocks.recordAiFeedback.mockResolvedValue({
      id: "feedback-1",
      feedbackType: "packet_quality",
      feedbackValue: "useful",
    });

    const app = createApp("rep");
    const res = await request(app)
      .post("/api/ai/feedback")
      .send({
        targetType: "packet",
        targetId: "11111111-1111-4111-8111-111111111111",
        feedbackType: "packet_quality",
        feedbackValue: "useful",
      });

    expect(res.status).toBe(201);
    expect(serviceMocks.recordAiFeedback).toHaveBeenCalledWith(expect.anything(), {
      targetType: "packet",
      targetId: "11111111-1111-4111-8111-111111111111",
      userId: "rep-1",
      feedbackType: "packet_quality",
      feedbackValue: "useful",
      comment: null,
    });
  });

  it("rejects invalid feedback target ids", async () => {
    const app = createApp("rep");
    const res = await request(app)
      .post("/api/ai/feedback")
      .send({
        targetType: "packet",
        targetId: "sales-process-disconnect-dashboard",
        feedbackType: "packet_quality",
        feedbackValue: "useful",
      });

    expect(res.status).toBe(400);
    expect(serviceMocks.recordAiFeedback).not.toHaveBeenCalled();
  });

  it("rejects feedback fields that exceed schema length limits", async () => {
    const app = createApp("rep");
    const res = await request(app)
      .post("/api/ai/feedback")
      .send({
        targetType: "sales_process_disconnect_dashboard",
        targetId: "11111111-1111-4111-8111-111111111111",
        feedbackType: "ops_dashboard_interaction",
        feedbackValue: "dashboard_view",
      });

    expect(res.status).toBe(400);
    expect(serviceMocks.recordAiFeedback).not.toHaveBeenCalled();
  });

  it("restricts blind-spot summary to director/admin roles", async () => {
    const app = createApp("rep");
    const res = await request(app).get("/api/ai/blind-spots");

    expect(res.status).toBe(403);
  });

  it("returns the director blind-spot summary for director users", async () => {
    serviceMocks.getDirectorBlindSpots.mockResolvedValue([
      { id: "risk-1", title: "No follow-up task", severity: "warning" },
    ]);

    const app = createApp("director");
    const res = await request(app).get("/api/ai/blind-spots");

    expect(res.status).toBe(200);
    expect(serviceMocks.getDirectorBlindSpots).toHaveBeenCalledWith(expect.anything());
    expect(res.body.blindSpots).toHaveLength(1);
  });

  it("returns AI ops metrics for director users", async () => {
    serviceMocks.getAiOpsMetrics.mockResolvedValue({
      packetsGenerated24h: 10,
      packetsPending: 1,
      avgConfidence7d: 0.81,
      openBlindSpots: 4,
      suggestionsAccepted30d: 6,
      suggestionsDismissed30d: 2,
      positiveFeedback30d: 3,
      negativeFeedback30d: 1,
      documentsIndexed: 20,
      documentsPending: 5,
      documentStatusBySource: [],
    });

    const app = createApp("director");
    const res = await request(app).get("/api/ai/ops/metrics");

    expect(res.status).toBe(200);
    expect(serviceMocks.getAiOpsMetrics).toHaveBeenCalledWith(expect.anything());
    expect(res.body.metrics.packetsGenerated24h).toBe(10);
  });

  it("returns intervention analytics for admins", async () => {
    interventionServiceMocks.getInterventionAnalyticsDashboard.mockResolvedValue({
      summary: { openCases: 1 },
      outcomes: { actionVolume30d: { assign: 0, snooze: 0, resolve: 0, escalate: 0 } },
      hotspots: { assignees: [], disconnectTypes: [], reps: [], companies: [], stages: [] },
      breachQueue: { items: [], totalCount: 0, pageSize: 25 },
      slaRules: { criticalDays: 0, highDays: 2, mediumDays: 5, lowDays: 10, timingBasis: "business_days" },
      managerBrief: {
        headline: "No strong manager brief is available yet.",
        summaryWindowLabel: "Compared with the prior 7 days",
        whatChanged: [],
        focusNow: [],
        emergingPatterns: [],
        groundingNote: "Manager brief unavailable. Continue monitoring queue health and outcome trends.",
        error: null,
      },
    });

    const app = createApp("admin");
    const response = await request(app)
      .get("/api/ai/ops/intervention-analytics");

    expect(response.status).toBe(200);
    expect(response.body.summary).toBeDefined();
    expect(response.body.breachQueue.items).toBeInstanceOf(Array);
    expect(response.body.managerBrief).toBeDefined();
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it("returns the latest persisted manager alert snapshot for the active office", async () => {
    interventionServiceMocks.getLatestManagerAlertSnapshot.mockResolvedValue({
      id: "snapshot-1",
      officeId: "office-1",
      snapshotKind: "manager_alert_summary",
      snapshotMode: "sent",
      snapshotJson: { version: 1, officeId: "office-1" },
      scannedAt: new Date("2026-04-16T15:00:00.000Z"),
      sentAt: new Date("2026-04-16T15:05:00.000Z"),
      createdAt: new Date("2026-04-16T15:00:00.000Z"),
      updatedAt: new Date("2026-04-16T15:05:00.000Z"),
    });

    const app = createApp("director");
    const res = await request(app).get("/api/ai/ops/intervention-manager-alerts");

    expect(res.status).toBe(200);
    expect(interventionServiceMocks.getLatestManagerAlertSnapshot).toHaveBeenCalledWith(expect.anything(), {
      officeId: "office-1",
    });
    expect(interventionServiceMocks.runManagerAlertPreview).not.toHaveBeenCalled();
    expect(interventionServiceMocks.sendManagerAlertSummary).not.toHaveBeenCalled();
    expect(res.body.snapshotMode).toBe("sent");
    expect(res.body.snapshotKind).toBe("manager_alert_summary");
  });

  it("runs a preview-only manager alert scan for the active office", async () => {
    interventionServiceMocks.runManagerAlertPreview.mockResolvedValue({
      id: "snapshot-2",
      officeId: "office-1",
      snapshotKind: "manager_alert_summary",
      snapshotMode: "preview",
      snapshotJson: { version: 1, officeId: "office-1" },
      scannedAt: new Date("2026-04-16T16:00:00.000Z"),
      sentAt: null,
      createdAt: new Date("2026-04-16T16:00:00.000Z"),
      updatedAt: new Date("2026-04-16T16:00:00.000Z"),
    });

    const app = createApp("admin");
    const res = await request(app)
      .post("/api/ai/ops/intervention-manager-alerts/scan")
      .send({});

    expect(res.status).toBe(200);
    expect(interventionServiceMocks.runManagerAlertPreview).toHaveBeenCalledWith(expect.anything(), {
      officeId: "office-1",
    });
    expect(interventionServiceMocks.getLatestManagerAlertSnapshot).not.toHaveBeenCalled();
    expect(interventionServiceMocks.sendManagerAlertSummary).not.toHaveBeenCalled();
    expect(res.body.snapshotMode).toBe("preview");
    expect(res.body.sentAt).toBeNull();
  });

  it("sends manager alerts manually for the current office context", async () => {
    selectMock.mockReturnValue({
      from: vi.fn().mockResolvedValue([
        {
          id: "admin-1",
          officeId: "office-1",
          role: "admin",
          isActive: true,
        },
        {
          id: "director-1",
          officeId: "office-1",
          role: "director",
          isActive: true,
        },
        {
          id: "rep-1",
          officeId: "office-1",
          role: "rep",
          isActive: true,
        },
        {
          id: "admin-other-office",
          officeId: "office-2",
          role: "admin",
          isActive: true,
        },
        {
          id: "inactive-director",
          officeId: "office-1",
          role: "director",
          isActive: false,
        },
      ]),
    });

    interventionServiceMocks.sendManagerAlertSummary.mockResolvedValue({
      claimed: true,
      snapshot: {
        id: "snapshot-3",
        officeId: "office-1",
        snapshotKind: "manager_alert_summary",
        snapshotMode: "sent",
        snapshotJson: { version: 1, officeId: "office-1" },
        scannedAt: new Date("2026-04-16T17:00:00.000Z"),
        sentAt: new Date("2026-04-16T17:01:00.000Z"),
        createdAt: new Date("2026-04-16T17:00:00.000Z"),
        updatedAt: new Date("2026-04-16T17:01:00.000Z"),
      },
      notification: {
        id: "notification-1",
        userId: "admin-1",
        type: "manager_alert_summary",
        title: "Manager alerts: 1 items need attention",
        body: "High-priority intervention pressure needs attention today.",
        link: "/admin/intervention-analytics",
        isRead: false,
        readAt: null,
        createdAt: new Date("2026-04-16T17:01:00.000Z"),
      },
    });

    const app = createApp("director");
    const res = await request(app)
      .post("/api/ai/ops/intervention-manager-alerts/send")
      .send({});

    expect(res.status).toBe(200);
    expect(interventionServiceMocks.sendManagerAlertSummary).toHaveBeenCalledTimes(2);
    expect(interventionServiceMocks.sendManagerAlertSummary).toHaveBeenNthCalledWith(1, expect.anything(), {
      officeId: "office-1",
      recipientUserId: "admin-1",
    });
    expect(interventionServiceMocks.sendManagerAlertSummary).toHaveBeenNthCalledWith(2, expect.anything(), {
      officeId: "office-1",
      recipientUserId: "director-1",
    });
    expect(interventionServiceMocks.getLatestManagerAlertSnapshot).not.toHaveBeenCalled();
    expect(interventionServiceMocks.runManagerAlertPreview).not.toHaveBeenCalled();
    expect(res.body.snapshot.snapshotMode).toBe("sent");
    expect(res.body.snapshot.snapshotKind).toBe("manager_alert_summary");
    expect(res.body.deliveries).toHaveLength(2);
    expect(res.body.deliveries[0].notification.link).toBe("/admin/intervention-analytics");
  });

  it("returns AI review queue for director users", async () => {
    serviceMocks.getAiReviewQueue.mockResolvedValue([
      { packetId: "packet-1", dealName: "Alpha Plaza" },
    ]);

    const app = createApp("director");
    const res = await request(app).get("/api/ai/ops/reviews?limit=5");

    expect(res.status).toBe(200);
    expect(serviceMocks.getAiReviewQueue).toHaveBeenCalledWith(expect.anything(), { limit: 5 });
    expect(res.body.reviews).toHaveLength(1);
  });

  it("returns AI action queue for director users", async () => {
    serviceMocks.getAiActionQueue.mockResolvedValue([
      { entryType: "blind_spot", id: "risk-1", title: "No follow-up task" },
    ]);

    const app = createApp("director");
    const res = await request(app).get("/api/ai/ops/action-queue?limit=5");

    expect(res.status).toBe(200);
    expect(serviceMocks.getAiActionQueue).toHaveBeenCalledWith(expect.anything(), { limit: 5 });
    expect(res.body.queue).toHaveLength(1);
  });

  it("returns intervention cases for director users", async () => {
    interventionServiceMocks.listInterventionCases.mockResolvedValue({
      items: [
        {
          id: "case-1",
          businessKey: "office-1:missing_next_task:deal:deal-1",
          disconnectType: "missing_next_task",
          clusterKey: "follow_through_gap",
          severity: "high",
          status: "open",
          escalated: false,
          ageDays: 5,
          assignedTo: null,
          generatedTask: null,
          deal: { id: "deal-1", dealNumber: "D-1001", name: "Alpha Plaza" },
          company: { id: "company-1", name: "Acme Property Group" },
          evidenceSummary: "Deal has no open next-step task.",
          lastIntervention: null,
        },
      ],
      totalCount: 1,
      page: 2,
      pageSize: 10,
    });

    const app = createApp("director");
    const res = await request(app).get("/api/ai/ops/interventions?page=2&limit=10&status=open&view=aging&clusterKey=follow_through_gap");

    expect(res.status).toBe(200);
    expect(interventionServiceMocks.listInterventionCases).toHaveBeenCalledWith(expect.anything(), {
      officeId: "office-1",
      page: 2,
      pageSize: 10,
      status: "open",
      view: "aging",
      clusterKey: "follow_through_gap",
      filters: {
        caseId: undefined,
        severity: undefined,
        disconnectType: undefined,
        assigneeId: undefined,
        repId: undefined,
        companyId: undefined,
        stageKey: undefined,
      },
    });
    expect(res.body.items).toHaveLength(1);
    expect(res.body.page).toBe(2);
  });

  it("passes overdue and source filters through the intervention queue route", async () => {
    interventionServiceMocks.listInterventionCases.mockResolvedValue({
      items: [],
      totalCount: 0,
      page: 1,
      pageSize: 50,
    });

    const app = createApp("director");
    const res = await request(app).get(
      "/api/ai/ops/interventions?view=snooze-breached&companyId=company-1&caseId=case-1"
    );

    expect(res.status).toBe(200);
    expect(interventionServiceMocks.listInterventionCases).toHaveBeenCalledWith(expect.anything(), {
      officeId: "office-1",
      page: undefined,
      pageSize: undefined,
      status: undefined,
      view: "snooze-breached",
      clusterKey: undefined,
      filters: {
        caseId: "case-1",
        severity: undefined,
        disconnectType: undefined,
        assigneeId: undefined,
        repId: undefined,
        companyId: "company-1",
        stageKey: undefined,
      },
    });
  });

  it("returns intervention case detail for director users", async () => {
    interventionServiceMocks.getInterventionCaseDetail.mockResolvedValue({
      case: {
        id: "case-1",
        businessKey: "office-1:missing_next_task:deal:deal-1",
        disconnectType: "missing_next_task",
        clusterKey: "follow_through_gap",
        severity: "high",
        status: "open",
        assignedTo: "manager-1",
        generatedTaskId: "task-1",
        escalated: false,
        snoozedUntil: null,
        reopenCount: 0,
        lastDetectedAt: "2026-04-16T15:00:00.000Z",
        lastIntervenedAt: null,
        resolvedAt: null,
        resolutionReason: null,
        metadataJson: null,
      },
      generatedTask: {
        id: "task-1",
        title: "Resolve Missing next task for D-1001",
        status: "pending",
        assignedTo: "manager-1",
      },
      crm: {
        deal: { id: "deal-1", dealNumber: "D-1001", name: "Alpha Plaza" },
        company: { id: "company-1", name: "Acme Property Group" },
      },
      history: [],
    });

    const app = createApp("director");
    const res = await request(app).get("/api/ai/ops/interventions/case-1");

    expect(res.status).toBe(200);
    expect(interventionServiceMocks.getInterventionCaseDetail).toHaveBeenCalledWith(expect.anything(), {
      officeId: "office-1",
      caseId: "case-1",
    });
    expect(res.body.case.id).toBe("case-1");
  });

  it("returns 404 when intervention case detail is missing", async () => {
    interventionServiceMocks.getInterventionCaseDetail.mockRejectedValue(
      new AppError(404, "Intervention case not found")
    );

    const app = createApp("director");
    const res = await request(app).get("/api/ai/ops/interventions/missing-case");

    expect(res.status).toBe(404);
  });

  it("returns intervention copilot view for director users", async () => {
    interventionServiceMocks.buildInterventionCopilotView.mockResolvedValue({
      packet: {
        id: "packet-1",
        scopeType: "intervention_case",
        scopeId: "case-1",
        packetKind: "intervention_case",
        status: "ready",
        snapshotHash: "hash-1",
        modelName: "heuristic",
        summaryText: "Owner alignment is likely needed.",
        nextStepJson: null,
        blindSpotsJson: [],
        evidenceJson: [],
        confidence: 0.78,
        generatedAt: "2026-04-19T12:00:00.000Z",
        expiresAt: null,
        createdAt: "2026-04-19T12:00:00.000Z",
        updatedAt: "2026-04-19T12:00:00.000Z",
      },
      recommendedAction: {
        action: "assign",
        rationale: "Task owner and case owner do not match.",
        suggestedOwner: "Admin User",
        suggestedOwnerId: "manager-1",
      },
      currentAssignee: { id: "manager-2", name: "Director User" },
      evidence: [],
      riskFlags: [],
      rootCause: null,
      blockerOwner: null,
      reopenRisk: null,
      similarCases: [],
      isRefreshPending: false,
      isStale: false,
      latestCaseChangedAt: "2026-04-19T12:00:00.000Z",
      packetGeneratedAt: "2026-04-19T12:00:00.000Z",
      viewerFeedbackValue: null,
    });

    const app = createApp("director");
    const res = await request(app).get("/api/ai/ops/interventions/case-1/copilot");

    expect(res.status).toBe(200);
    expect(interventionServiceMocks.buildInterventionCopilotView).toHaveBeenCalledWith(expect.anything(), {
      officeId: "office-1",
      caseId: "case-1",
      viewerUserId: "director-1",
    });
    expect(res.body).toMatchObject({
      packet: {
        id: "packet-1",
      },
      recommendedAction: {
        action: "assign",
      },
      currentAssignee: { id: "manager-2" },
      evidence: [],
      similarCases: [],
      isRefreshPending: false,
      isStale: false,
      latestCaseChangedAt: "2026-04-19T12:00:00.000Z",
      packetGeneratedAt: "2026-04-19T12:00:00.000Z",
    });
    expect(res.body.viewerFeedbackValue === null || typeof res.body.viewerFeedbackValue === "string").toBe(true);
  });

  it("returns intervention copilot view for admin users", async () => {
    interventionServiceMocks.buildInterventionCopilotView.mockResolvedValue({
      packet: {
        id: "packet-1",
        scopeType: "intervention_case",
        scopeId: "case-1",
        packetKind: "intervention_case",
        status: "ready",
        snapshotHash: "hash-1",
        modelName: "heuristic",
        summaryText: "Owner alignment is likely needed.",
        nextStepJson: null,
        blindSpotsJson: [],
        evidenceJson: [],
        confidence: 0.78,
        generatedAt: "2026-04-19T12:00:00.000Z",
        expiresAt: null,
        createdAt: "2026-04-19T12:00:00.000Z",
        updatedAt: "2026-04-19T12:00:00.000Z",
      },
      recommendedAction: null,
      currentAssignee: null,
      evidence: [],
      riskFlags: [],
      rootCause: null,
      blockerOwner: null,
      reopenRisk: null,
      similarCases: [],
      isRefreshPending: false,
      isStale: false,
      latestCaseChangedAt: null,
      packetGeneratedAt: null,
      viewerFeedbackValue: null,
    });

    const app = createApp("admin");
    const res = await request(app).get("/api/ai/ops/interventions/case-1/copilot");

    expect(res.status).toBe(200);
    expect(interventionServiceMocks.buildInterventionCopilotView).toHaveBeenCalledWith(expect.anything(), {
      officeId: "office-1",
      caseId: "case-1",
      viewerUserId: "admin-1",
    });
  });

  it("regenerates intervention copilot packets for director users", async () => {
    interventionServiceMocks.regenerateInterventionCopilot.mockResolvedValue({
      queued: false,
      packetId: "packet-1",
      packetGeneratedAt: "2026-04-19T12:00:00.000Z",
      requestedBy: "director-1",
    });

    const app = createApp("director");
    const res = await request(app).post("/api/ai/ops/interventions/case-1/copilot/regenerate").send({});

    expect(res.status).toBe(200);
    expect(interventionServiceMocks.regenerateInterventionCopilot).toHaveBeenCalledWith(expect.anything(), {
      officeId: "office-1",
      caseId: "case-1",
      requestedBy: "director-1",
    });
    expect(res.body).toEqual({
      queued: false,
      packetId: "packet-1",
      packetGeneratedAt: "2026-04-19T12:00:00.000Z",
      requestedBy: "director-1",
    });
  });

  it("rejects intervention copilot routes for unauthorized roles", async () => {
    const app = createApp("rep");

    const getRes = await request(app).get("/api/ai/ops/interventions/case-1/copilot");
    const postRes = await request(app).post("/api/ai/ops/interventions/case-1/copilot/regenerate").send({});

    expect(getRes.status).toBe(403);
    expect(postRes.status).toBe(403);
    expect(interventionServiceMocks.buildInterventionCopilotView).not.toHaveBeenCalled();
    expect(interventionServiceMocks.regenerateInterventionCopilot).not.toHaveBeenCalled();
  });

  it("applies batch intervention mutations for director users", async () => {
    interventionServiceMocks.assignInterventionCases.mockResolvedValue({
      updatedCount: 1,
      skippedCount: 1,
      errors: [{ caseId: "case-2", message: "Cannot assign a resolved case" }],
    });
    interventionServiceMocks.snoozeInterventionCases.mockResolvedValue({
      updatedCount: 1,
      skippedCount: 1,
      errors: [{ caseId: "case-2", message: "Cannot snooze a resolved case" }],
    });
    interventionServiceMocks.resolveInterventionCases.mockResolvedValue({
      updatedCount: 1,
      skippedCount: 1,
      errors: [{ caseId: "case-2", message: "Case is already resolved" }],
    });
    interventionServiceMocks.escalateInterventionCases.mockResolvedValue({
      updatedCount: 1,
      skippedCount: 1,
      errors: [{ caseId: "case-2", message: "Case is already escalated" }],
    });

    const app = createApp("director");

    const conflictingResolveRes = await request(app)
      .post("/api/ai/ops/interventions/case-1/resolve")
      .send({
        resolutionReason: "owner_aligned",
        conclusion: {
          kind: "resolve",
          outcomeCategory: "task_completed",
          reasonCode: "missing_task_created_and_completed",
          effectiveness: "confirmed",
        },
      });
    expect(conflictingResolveRes.status).toBe(400);

    const conflictingSnoozeRes = await request(app)
      .post("/api/ai/ops/interventions/case-1/snooze")
      .send({
        snoozedUntil: "2026-04-20T00:00:00.000Z",
        notes: "legacy note",
        conclusion: {
          kind: "snooze",
          snoozeReasonCode: "waiting_on_customer",
          expectedOwnerType: "rep",
          expectedNextStepCode: "rep_follow_up_expected",
        },
      });
    expect(conflictingSnoozeRes.status).toBe(400);

    const missingStructuredResolveRes = await request(app)
      .post("/api/ai/ops/interventions/batch-resolve")
      .send({ caseIds: ["case-1"], resolutionReason: "owner_aligned" });
    expect(missingStructuredResolveRes.status).toBe(400);

    const missingStructuredSnoozeRes = await request(app)
      .post("/api/ai/ops/interventions/batch-snooze")
      .send({ caseIds: ["case-1"], snoozedUntil: "2026-04-20T00:00:00.000Z" });
    expect(missingStructuredSnoozeRes.status).toBe(400);

    const missingStructuredEscalateRes = await request(app)
      .post("/api/ai/ops/interventions/batch-escalate")
      .send({ caseIds: ["case-1"] });
    expect(missingStructuredEscalateRes.status).toBe(400);

    interventionServiceMocks.assertHomogeneousBatchConclusionCohort.mockRejectedValueOnce(
      new AppError(400, "Batch conclusion requires a homogeneous cohort")
    );
    const heterogeneousBatchRes = await request(app)
      .post("/api/ai/ops/interventions/batch-resolve")
      .send({
        caseIds: ["case-1", "case-2"],
        conclusion: {
          kind: "resolve",
          outcomeCategory: "task_completed",
          reasonCode: "missing_task_created_and_completed",
          effectiveness: "confirmed",
        },
      });
    expect(heterogeneousBatchRes.status).toBe(400);

    const assignRes = await request(app)
      .post("/api/ai/ops/interventions/batch-assign")
      .send({ caseIds: ["case-1", "case-2"], assignedTo: "manager-2", notes: "Rebalance queue" });
    expect(assignRes.status).toBe(200);
    expect(assignRes.body).toEqual({
      updatedCount: 1,
      skippedCount: 1,
      errors: [{ caseId: "case-2", message: "Cannot assign a resolved case" }],
    });
    expect(interventionServiceMocks.assignInterventionCases).toHaveBeenCalledWith(expect.anything(), {
      officeId: "office-1",
      actorUserId: "director-1",
      actorRole: "director",
      caseIds: ["case-1", "case-2"],
      assignedTo: "manager-2",
      notes: "Rebalance queue",
    });

    const snoozeRes = await request(app)
      .post("/api/ai/ops/interventions/batch-snooze")
      .send({
        caseIds: ["case-1", "case-2"],
        snoozedUntil: "2026-04-20T00:00:00.000Z",
        conclusion: {
          kind: "snooze",
          snoozeReasonCode: "waiting_on_customer",
          expectedOwnerType: "customer",
          expectedNextStepCode: "customer_reply_expected",
          notes: "Waiting on customer reply",
        },
      });
    expect(snoozeRes.status).toBe(200);
    expect(snoozeRes.body).toEqual({
      updatedCount: 1,
      skippedCount: 1,
      errors: [{ caseId: "case-2", message: "Cannot snooze a resolved case" }],
    });
    expect(interventionServiceMocks.snoozeInterventionCases).toHaveBeenCalledWith(expect.anything(), {
      officeId: "office-1",
      actorUserId: "director-1",
      actorRole: "director",
      caseIds: ["case-1", "case-2"],
      snoozedUntil: "2026-04-20T00:00:00.000Z",
      conclusion: {
        kind: "snooze",
        snoozeReasonCode: "waiting_on_customer",
        expectedOwnerType: "customer",
        expectedNextStepCode: "customer_reply_expected",
        notes: "Waiting on customer reply",
      },
      allowLegacyOutcomeWrites: false,
      notes: null,
    });

    const resolveRes = await request(app)
      .post("/api/ai/ops/interventions/batch-resolve")
      .send({
        caseIds: ["case-1", "case-2"],
        conclusion: {
          kind: "resolve",
          outcomeCategory: "owner_aligned",
          reasonCode: "owner_assigned_and_confirmed",
          effectiveness: "likely",
          notes: "Owner already aligned on next step",
        },
      });
    expect(resolveRes.status).toBe(200);
    expect(resolveRes.body).toEqual({
      updatedCount: 1,
      skippedCount: 1,
      errors: [{ caseId: "case-2", message: "Case is already resolved" }],
    });
    expect(interventionServiceMocks.resolveInterventionCases).toHaveBeenCalledWith(expect.anything(), {
      officeId: "office-1",
      actorUserId: "director-1",
      actorRole: "director",
      caseIds: ["case-1", "case-2"],
      resolutionReason: "owner_aligned",
      conclusion: {
        kind: "resolve",
        outcomeCategory: "owner_aligned",
        reasonCode: "owner_assigned_and_confirmed",
        effectiveness: "likely",
        notes: "Owner already aligned on next step",
      },
      allowLegacyOutcomeWrites: false,
      notes: null,
    });

    const invalidResolveRes = await request(app)
      .post("/api/ai/ops/interventions/batch-resolve")
      .send({
        caseIds: ["case-1", "case-2"],
        resolutionReason: "bad_reason",
        conclusion: {
          kind: "resolve",
          outcomeCategory: "task_completed",
          reasonCode: "missing_task_created_and_completed",
          effectiveness: "confirmed",
        },
      });
    expect(invalidResolveRes.status).toBe(400);

    const escalateRes = await request(app)
      .post("/api/ai/ops/interventions/batch-escalate")
      .send({
        caseIds: ["case-1", "case-2"],
        conclusion: {
          kind: "escalate",
          escalationReasonCode: "manager_visibility_required",
          escalationTargetType: "director",
          urgency: "high",
          notes: "Needs leadership review",
        },
      });
    expect(escalateRes.status).toBe(200);
    expect(escalateRes.body).toEqual({
      updatedCount: 1,
      skippedCount: 1,
      errors: [{ caseId: "case-2", message: "Case is already escalated" }],
    });
    expect(interventionServiceMocks.escalateInterventionCases).toHaveBeenCalledWith(expect.anything(), {
      officeId: "office-1",
      actorUserId: "director-1",
      actorRole: "director",
      caseIds: ["case-1", "case-2"],
      conclusion: {
        kind: "escalate",
        escalationReasonCode: "manager_visibility_required",
        escalationTargetType: "director",
        urgency: "high",
        notes: "Needs leadership review",
      },
      allowLegacyOutcomeWrites: false,
      notes: null,
    });
  });

  it("applies single-case intervention mutations for director users", async () => {
    interventionServiceMocks.assignInterventionCases.mockResolvedValue({
      updatedCount: 0,
      skippedCount: 1,
      errors: [{ caseId: "case-1", message: "Cannot assign a resolved case" }],
    });
    interventionServiceMocks.snoozeInterventionCases.mockResolvedValue({
      updatedCount: 0,
      skippedCount: 1,
      errors: [{ caseId: "case-1", message: "Cannot snooze a resolved case" }],
    });
    interventionServiceMocks.resolveInterventionCases.mockResolvedValue({
      updatedCount: 0,
      skippedCount: 1,
      errors: [{ caseId: "case-1", message: "Case is already resolved" }],
    });
    interventionServiceMocks.escalateInterventionCases.mockResolvedValue({
      updatedCount: 0,
      skippedCount: 1,
      errors: [{ caseId: "case-1", message: "Case is already escalated" }],
    });

    const app = createApp("director");

    const assignRes = await request(app)
      .post("/api/ai/ops/interventions/case-1/assign")
      .send({ assignedTo: "manager-2", notes: "Direct owner change" });
    expect(assignRes.status).toBe(200);
    expect(assignRes.body).toEqual({
      updatedCount: 0,
      skippedCount: 1,
      errors: [{ caseId: "case-1", message: "Cannot assign a resolved case" }],
    });
    expect(interventionServiceMocks.assignInterventionCases).toHaveBeenCalledWith(expect.anything(), {
      officeId: "office-1",
      actorUserId: "director-1",
      actorRole: "director",
      caseIds: ["case-1"],
      assignedTo: "manager-2",
      notes: "Direct owner change",
    });

    const snoozeRes = await request(app)
      .post("/api/ai/ops/interventions/case-1/snooze")
      .send({
        snoozedUntil: "2026-04-20T00:00:00.000Z",
        conclusion: {
          kind: "snooze",
          snoozeReasonCode: "waiting_on_customer",
          expectedOwnerType: "customer",
          expectedNextStepCode: "customer_reply_expected",
          notes: "Waiting for reply",
        },
      });
    expect(snoozeRes.status).toBe(200);
    expect(snoozeRes.body).toEqual({
      updatedCount: 0,
      skippedCount: 1,
      errors: [{ caseId: "case-1", message: "Cannot snooze a resolved case" }],
    });
    expect(interventionServiceMocks.snoozeInterventionCases).toHaveBeenCalledWith(expect.anything(), {
      officeId: "office-1",
      actorUserId: "director-1",
      actorRole: "director",
      caseIds: ["case-1"],
      snoozedUntil: "2026-04-20T00:00:00.000Z",
      conclusion: {
        kind: "snooze",
        snoozeReasonCode: "waiting_on_customer",
        expectedOwnerType: "customer",
        expectedNextStepCode: "customer_reply_expected",
        notes: "Waiting for reply",
      },
      allowLegacyOutcomeWrites: false,
      notes: null,
    });

    const resolveRes = await request(app)
      .post("/api/ai/ops/interventions/case-1/resolve")
      .send({
        conclusion: {
          kind: "resolve",
          outcomeCategory: "task_completed",
          reasonCode: "missing_task_created_and_completed",
          effectiveness: "confirmed",
          notes: "Task is complete",
        },
      });
    expect(resolveRes.status).toBe(200);
    expect(resolveRes.body).toEqual({
      updatedCount: 0,
      skippedCount: 1,
      errors: [{ caseId: "case-1", message: "Case is already resolved" }],
    });
    expect(interventionServiceMocks.resolveInterventionCases).toHaveBeenCalledWith(expect.anything(), {
      officeId: "office-1",
      actorUserId: "director-1",
      actorRole: "director",
      caseIds: ["case-1"],
      resolutionReason: "task_completed",
      conclusion: {
        kind: "resolve",
        outcomeCategory: "task_completed",
        reasonCode: "missing_task_created_and_completed",
        effectiveness: "confirmed",
        notes: "Task is complete",
      },
      allowLegacyOutcomeWrites: false,
      notes: null,
    });

    const invalidResolveRes = await request(app)
      .post("/api/ai/ops/interventions/case-1/resolve")
      .send({
        resolutionReason: "bad_reason",
        conclusion: {
          kind: "resolve",
          outcomeCategory: "task_completed",
          reasonCode: "missing_task_created_and_completed",
          effectiveness: "confirmed",
        },
      });
    expect(invalidResolveRes.status).toBe(400);

    const escalateRes = await request(app)
      .post("/api/ai/ops/interventions/case-1/escalate")
      .send({
        conclusion: {
          kind: "escalate",
          escalationReasonCode: "manager_visibility_required",
          escalationTargetType: "director",
          urgency: "high",
          notes: "Director visibility needed",
        },
      });
    expect(escalateRes.status).toBe(200);
    expect(escalateRes.body).toEqual({
      updatedCount: 0,
      skippedCount: 1,
      errors: [{ caseId: "case-1", message: "Case is already escalated" }],
    });
    expect(interventionServiceMocks.escalateInterventionCases).toHaveBeenCalledWith(expect.anything(), {
      officeId: "office-1",
      actorUserId: "director-1",
      actorRole: "director",
      caseIds: ["case-1"],
      conclusion: {
        kind: "escalate",
        escalationReasonCode: "manager_visibility_required",
        escalationTargetType: "director",
        urgency: "high",
        notes: "Director visibility needed",
      },
      allowLegacyOutcomeWrites: false,
      notes: null,
    });
  });

  it("applies a triage action to an AI action queue entry", async () => {
    serviceMocks.triageAiActionQueueEntry.mockResolvedValue({
      entryType: "blind_spot",
      id: "risk-1",
      action: "resolve",
      feedbackId: "feedback-1",
      targetStatus: "resolved",
    });

    const app = createApp("director");
    const res = await request(app)
      .post("/api/ai/ops/action-queue/blind_spot/risk-1")
      .send({ action: "resolve", comment: "Manager handled this directly." });

    expect(res.status).toBe(200);
    expect(serviceMocks.triageAiActionQueueEntry).toHaveBeenCalledWith(expect.anything(), {
      entryType: "blind_spot",
      id: "risk-1",
      action: "resolve",
      userId: "director-1",
      comment: "Manager handled this directly.",
    });
    expect(res.body.targetStatus).toBe("resolved");
  });

  it("queues an AI backfill job for director users", async () => {
    const app = createApp("director");
    const res = await request(app)
      .post("/api/ai/ops/backfill")
      .send({ sourceType: "email_message", batchSize: 75 });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ queued: true, sourceType: "email_message", batchSize: 75 });
    expect(insertMock).toHaveBeenCalledTimes(1);
  });

  it("queues an AI disconnect digest job for director users", async () => {
    const app = createApp("director");
    const res = await request(app)
      .post("/api/ai/ops/disconnect-digest")
      .send({ mode: "manual" });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ queued: true, mode: "manual" });
    expect(insertMock).toHaveBeenCalledTimes(1);
  });

  it("queues an AI disconnect escalation scan for director users", async () => {
    const app = createApp("director");
    const res = await request(app)
      .post("/api/ai/ops/disconnect-escalation-scan")
      .send({ mode: "manual" });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ queued: true, mode: "manual" });
    expect(insertMock).toHaveBeenCalledTimes(1);
  });

  it("queues deterministic admin tasks for director users", async () => {
    const app = createApp("director");
    const res = await request(app)
      .post("/api/ai/ops/disconnect-admin-tasks")
      .send({ mode: "manual" });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ queued: true, mode: "manual" });
    expect(insertMock).toHaveBeenCalledTimes(1);
  });

  it("returns sales process disconnects for director users", async () => {
    serviceMocks.getSalesProcessDisconnectDashboard.mockResolvedValue({
      summary: {
        activeDeals: 18,
        totalDisconnects: 11,
        staleStageCount: 3,
        missingNextTaskCount: 2,
        inboundWithoutFollowupCount: 1,
        revisionLoopCount: 2,
        estimatingGateGapCount: 1,
        procoreBidBoardDriftCount: 2,
      },
      automation: {
        digestNotifications7d: 3,
        escalationNotifications7d: 2,
        adminTasksCreated7d: 4,
        adminTasksOpen: 2,
        latestDigestAt: "2026-04-15T12:00:00.000Z",
        latestEscalationAt: "2026-04-15T13:00:00.000Z",
        latestAdminTaskCreatedAt: "2026-04-15T14:00:00.000Z",
      },
      narrative: {
        headline: "Bid board / CRM stage drift is the dominant disconnect this week.",
        summary: "11 disconnects are open across 18 active deals.",
        whatChanged: "Acme Group is showing the heaviest concentration of current disconnects.",
        adminFocus: "Prioritize bid board reconciliation before follow-through gaps spread.",
        recommendedActions: ["Escalate bid board drift first."],
      },
      byType: [
        { disconnectType: "stale_stage", label: "Stalled in stage", count: 3 },
      ],
      clusters: [
        { clusterKey: "bid_board_sync_break", title: "Bid board / CRM stage drift", dealCount: 2 },
      ],
      trends: {
        reps: [{ key: "rep-1", label: "Morgan Rep", disconnectCount: 3 }],
        stages: [{ key: "estimating", label: "Estimating", disconnectCount: 4 }],
        companies: [{ key: "company-1", label: "Acme Group", disconnectCount: 2 }],
      },
      outcomes: {
        interventionDeals30d: 5,
        clearedAfterIntervention30d: 2,
        stillOpenAfterIntervention30d: 3,
        unresolvedEscalationsOpen: 1,
        repeatIssueDealsOpen: 4,
        repeatClusterDealsOpen: 2,
        interventionCoverageRate: 0.5,
        clearanceRate30d: 0.4,
      },
      actionSummary: {
        markReviewed30d: 2,
        resolve30d: 1,
        dismiss30d: 0,
        escalate30d: 2,
        bestOverallAction: "resolve",
        bestOverallClearanceRate: 1,
      },
      playbooks: [
        { clusterKey: "bid_board_sync_break", bestAction: "escalate", recommendedAction: "escalate" },
      ],
      rows: [
        { id: "deal-1", dealNumber: "D-1001", dealName: "Alpha Plaza" },
      ],
    });

    const app = createApp("director");
    const res = await request(app).get("/api/ai/ops/process-disconnects?limit=25");

    expect(res.status).toBe(200);
    expect(serviceMocks.getSalesProcessDisconnectDashboard).toHaveBeenCalledWith(expect.anything(), { limit: 25 });
    expect(res.body.summary.totalDisconnects).toBe(11);
    expect(res.body.summary.procoreBidBoardDriftCount).toBe(2);
    expect(res.body.clusters[0].clusterKey).toBe("bid_board_sync_break");
    expect(res.body.narrative.headline).toContain("dominant disconnect");
    expect(res.body.trends.reps[0].disconnectCount).toBe(3);
    expect(res.body.outcomes.clearanceRate30d).toBe(0.4);
    expect(res.body.actionSummary.bestOverallAction).toBe("resolve");
    expect(res.body.playbooks[0].recommendedAction).toBe("escalate");
    expect(res.body.rows).toHaveLength(1);
  });

});
