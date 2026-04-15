import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const serviceMocks = vi.hoisted(() => ({
  getDealCopilotView: vi.fn(),
  regenerateDealCopilot: vi.fn(),
  dismissTaskSuggestion: vi.fn(),
  recordAiFeedback: vi.fn(),
  getDirectorBlindSpots: vi.fn(),
}));

const taskSuggestionMocks = vi.hoisted(() => ({
  acceptTaskSuggestion: vi.fn(),
}));

const dealsServiceMocks = vi.hoisted(() => ({
  getDealById: vi.fn(),
}));

vi.mock("../../../src/modules/ai-copilot/service.js", () => ({
  getDealCopilotView: serviceMocks.getDealCopilotView,
  regenerateDealCopilot: serviceMocks.regenerateDealCopilot,
  dismissTaskSuggestion: serviceMocks.dismissTaskSuggestion,
  recordAiFeedback: serviceMocks.recordAiFeedback,
  getDirectorBlindSpots: serviceMocks.getDirectorBlindSpots,
}));

vi.mock("../../../src/modules/ai-copilot/task-suggestion-service.js", () => ({
  acceptTaskSuggestion: taskSuggestionMocks.acceptTaskSuggestion,
}));

vi.mock("../../../src/modules/deals/service.js", () => ({
  getDealById: dealsServiceMocks.getDealById,
}));

const { aiCopilotRoutes } = await import("../../../src/modules/ai-copilot/routes.js");
const { errorHandler } = await import("../../../src/middleware/error-handler.js");

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
    req.tenantDb = {} as any;
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
    dealsServiceMocks.getDealById.mockResolvedValue({
      id: "deal-1",
      assignedRepId: "rep-1",
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

  it("triggers a deal copilot regeneration", async () => {
    serviceMocks.regenerateDealCopilot.mockResolvedValue({
      packetId: "packet-2",
      summary: "Fresh summary",
    });

    const app = createApp("rep");
    const res = await request(app).post("/api/ai/deals/deal-1/regenerate");

    expect(res.status).toBe(202);
    expect(serviceMocks.regenerateDealCopilot).toHaveBeenCalledWith(expect.anything(), "deal-1");
    expect(res.body.packetId).toBe("packet-2");
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
        targetId: "packet-1",
        feedbackType: "packet_quality",
        feedbackValue: "useful",
      });

    expect(res.status).toBe(201);
    expect(serviceMocks.recordAiFeedback).toHaveBeenCalledWith(expect.anything(), {
      targetType: "packet",
      targetId: "packet-1",
      userId: "rep-1",
      feedbackType: "packet_quality",
      feedbackValue: "useful",
      comment: null,
    });
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
});
