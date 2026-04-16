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
  getInterventionCaseDetail: vi.fn(),
  assignInterventionCases: vi.fn(),
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
  getInterventionCaseDetail: interventionServiceMocks.getInterventionCaseDetail,
  assignInterventionCases: interventionServiceMocks.assignInterventionCases,
  snoozeInterventionCases: interventionServiceMocks.snoozeInterventionCases,
  resolveInterventionCases: interventionServiceMocks.resolveInterventionCases,
  escalateInterventionCases: interventionServiceMocks.escalateInterventionCases,
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
    req.tenantDb = { insert: insertMock } as any;
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
    insertMock = vi.fn(() => ({
      values: vi.fn().mockResolvedValue(undefined),
    }));
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
    const res = await request(app).get("/api/ai/ops/interventions?page=2&limit=10&status=open");

    expect(res.status).toBe(200);
    expect(interventionServiceMocks.listInterventionCases).toHaveBeenCalledWith(expect.anything(), {
      officeId: "office-1",
      page: 2,
      pageSize: 10,
      status: "open",
    });
    expect(res.body.items).toHaveLength(1);
    expect(res.body.page).toBe(2);
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

  it("applies batch intervention mutations for director users", async () => {
    interventionServiceMocks.assignInterventionCases.mockResolvedValue({
      updatedCount: 2,
      skippedCount: 0,
      errors: [],
    });
    interventionServiceMocks.snoozeInterventionCases.mockResolvedValue({
      updatedCount: 2,
      skippedCount: 0,
      errors: [],
    });
    interventionServiceMocks.resolveInterventionCases.mockResolvedValue({
      updatedCount: 2,
      skippedCount: 0,
      errors: [],
    });
    interventionServiceMocks.escalateInterventionCases.mockResolvedValue({
      updatedCount: 2,
      skippedCount: 0,
      errors: [],
    });

    const app = createApp("director");

    const assignRes = await request(app)
      .post("/api/ai/ops/interventions/batch-assign")
      .send({ caseIds: ["case-1", "case-2"], assignedTo: "manager-2", notes: "Rebalance queue" });
    expect(assignRes.status).toBe(200);
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
        notes: "Waiting on customer reply",
      });
    expect(snoozeRes.status).toBe(200);
    expect(interventionServiceMocks.snoozeInterventionCases).toHaveBeenCalledWith(expect.anything(), {
      officeId: "office-1",
      actorUserId: "director-1",
      actorRole: "director",
      caseIds: ["case-1", "case-2"],
      snoozedUntil: "2026-04-20T00:00:00.000Z",
      notes: "Waiting on customer reply",
    });

    const resolveRes = await request(app)
      .post("/api/ai/ops/interventions/batch-resolve")
      .send({
        caseIds: ["case-1", "case-2"],
        resolutionReason: "owner_aligned",
        notes: "Owner already aligned on next step",
      });
    expect(resolveRes.status).toBe(200);
    expect(interventionServiceMocks.resolveInterventionCases).toHaveBeenCalledWith(expect.anything(), {
      officeId: "office-1",
      actorUserId: "director-1",
      actorRole: "director",
      caseIds: ["case-1", "case-2"],
      resolutionReason: "owner_aligned",
      notes: "Owner already aligned on next step",
    });

    const invalidResolveRes = await request(app)
      .post("/api/ai/ops/interventions/batch-resolve")
      .send({
        caseIds: ["case-1", "case-2"],
        resolutionReason: "bad_reason",
      });
    expect(invalidResolveRes.status).toBe(400);

    const escalateRes = await request(app)
      .post("/api/ai/ops/interventions/batch-escalate")
      .send({ caseIds: ["case-1", "case-2"], notes: "Needs leadership review" });
    expect(escalateRes.status).toBe(200);
    expect(interventionServiceMocks.escalateInterventionCases).toHaveBeenCalledWith(expect.anything(), {
      officeId: "office-1",
      actorUserId: "director-1",
      actorRole: "director",
      caseIds: ["case-1", "case-2"],
      notes: "Needs leadership review",
    });
  });

  it("applies single-case intervention mutations for director users", async () => {
    interventionServiceMocks.assignInterventionCases.mockResolvedValue({
      updatedCount: 1,
      skippedCount: 0,
      errors: [],
    });
    interventionServiceMocks.snoozeInterventionCases.mockResolvedValue({
      updatedCount: 1,
      skippedCount: 0,
      errors: [],
    });
    interventionServiceMocks.resolveInterventionCases.mockResolvedValue({
      updatedCount: 1,
      skippedCount: 0,
      errors: [],
    });
    interventionServiceMocks.escalateInterventionCases.mockResolvedValue({
      updatedCount: 1,
      skippedCount: 0,
      errors: [],
    });

    const app = createApp("director");

    const assignRes = await request(app)
      .post("/api/ai/ops/interventions/case-1/assign")
      .send({ assignedTo: "manager-2", notes: "Direct owner change" });
    expect(assignRes.status).toBe(200);
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
      .send({ snoozedUntil: "2026-04-20T00:00:00.000Z", notes: "Waiting for reply" });
    expect(snoozeRes.status).toBe(200);
    expect(interventionServiceMocks.snoozeInterventionCases).toHaveBeenCalledWith(expect.anything(), {
      officeId: "office-1",
      actorUserId: "director-1",
      actorRole: "director",
      caseIds: ["case-1"],
      snoozedUntil: "2026-04-20T00:00:00.000Z",
      notes: "Waiting for reply",
    });

    const resolveRes = await request(app)
      .post("/api/ai/ops/interventions/case-1/resolve")
      .send({ resolutionReason: "task_completed", notes: "Task is complete" });
    expect(resolveRes.status).toBe(200);
    expect(interventionServiceMocks.resolveInterventionCases).toHaveBeenCalledWith(expect.anything(), {
      officeId: "office-1",
      actorUserId: "director-1",
      actorRole: "director",
      caseIds: ["case-1"],
      resolutionReason: "task_completed",
      notes: "Task is complete",
    });

    const invalidResolveRes = await request(app)
      .post("/api/ai/ops/interventions/case-1/resolve")
      .send({ resolutionReason: "bad_reason" });
    expect(invalidResolveRes.status).toBe(400);

    const escalateRes = await request(app)
      .post("/api/ai/ops/interventions/case-1/escalate")
      .send({ notes: "Director visibility needed" });
    expect(escalateRes.status).toBe(200);
    expect(interventionServiceMocks.escalateInterventionCases).toHaveBeenCalledWith(expect.anything(), {
      officeId: "office-1",
      actorUserId: "director-1",
      actorRole: "director",
      caseIds: ["case-1"],
      notes: "Director visibility needed",
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
