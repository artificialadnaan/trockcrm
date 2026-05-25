import crypto from "crypto";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  processStageChanged: vi.fn(),
}));

vi.mock("../../../src/modules/synchub/procore-project-stage-relay-service.js", () => ({
  processSyncHubProcoreProjectStageChanged: mocks.processStageChanged,
}));

import { syncHubProcoreRelayRoutes } from "../../../src/modules/synchub/procore-project-relay-routes.js";

function createApp() {
  const app = express();
  app.use("/api/webhooks/synchub", syncHubProcoreRelayRoutes);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status((err as any).statusCode ?? 500).json({
      error: { message: err instanceof Error ? err.message : "Internal server error" },
    });
  });
  return app;
}

function signed(body: string, secret = "relay-secret") {
  return `sha256=${crypto.createHmac("sha256", secret).update(Buffer.from(body)).digest("hex")}`;
}

function body(overrides: Record<string, unknown> = {}) {
  return {
    eventType: "procore.project.stage_changed",
    source: "synchub",
    procore: {
      companyId: "598134325683880",
      portfolioProjectId: "987654321",
      projectNumber: "DFW-1-02326-ad",
      projectName: "T Rock Portfolio Project",
      previousStage: "Bidding",
      currentStage: "Buy Out",
    },
    stageChange: {
      previousStage: "Bidding",
      newStage: "Buy Out",
      detectedAt: "2026-05-20T14:15:00.000Z",
      webhookTimestamp: "2026-05-20T14:14:55.000Z",
    },
    synchub: {
      webhookLogId: "webhook-123",
      syncMappingId: "mapping-456",
      receivedAt: "2026-05-20T14:14:56.000Z",
      enrichedAt: "2026-05-20T14:15:00.000Z",
    },
    rawProcoreWebhook: { id: "raw-1" },
    ...overrides,
  };
}

describe("SyncHub Procore project stage-change relay route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SYNCHUB_RELAY_SECRET = "relay-secret";
    delete process.env.SYNCHUB_RELAY_RECEIVER_ENABLED;
    mocks.processStageChanged.mockResolvedValue({
      status: "recorded",
      officeId: "office-1",
      officeSlug: "main",
      projectId: "portfolio-project-1",
      stageEntryId: "stage-entry-1",
      isBoardRelevant: true,
    });
  });

  it("accepts a correctly signed stage-change payload", async () => {
    const raw = JSON.stringify(body());

    const response = await request(createApp())
      .post("/api/webhooks/synchub/procore-project-stage-changed")
      .set("Content-Type", "application/json")
      .set("X-SyncHub-Signature", signed(raw))
      .send(raw);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: "recorded", projectId: "portfolio-project-1" });
    expect(mocks.processStageChanged).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "procore.project.stage_changed" })
    );
  });

  it("rejects unsigned requests", async () => {
    const response = await request(createApp())
      .post("/api/webhooks/synchub/procore-project-stage-changed")
      .set("Content-Type", "application/json")
      .send(JSON.stringify(body()));

    expect(response.status).toBe(401);
    expect(mocks.processStageChanged).not.toHaveBeenCalled();
  });

  it("rejects tampered requests", async () => {
    const raw = JSON.stringify(body());
    const tampered = JSON.stringify(body({ procore: { ...body().procore, currentStage: "Closed" } }));

    const response = await request(createApp())
      .post("/api/webhooks/synchub/procore-project-stage-changed")
      .set("Content-Type", "application/json")
      .set("X-SyncHub-Signature", signed(raw))
      .send(tampered);

    expect(response.status).toBe(401);
    expect(mocks.processStageChanged).not.toHaveBeenCalled();
  });

  it("returns a controlled 400 for malformed JSON", async () => {
    const raw = "{";

    const response = await request(createApp())
      .post("/api/webhooks/synchub/procore-project-stage-changed")
      .set("Content-Type", "application/json")
      .set("X-SyncHub-Signature", signed(raw))
      .send(raw);

    expect(response.status).toBe(400);
    expect(mocks.processStageChanged).not.toHaveBeenCalled();
  });

  it("returns a controlled 400 when the request body is not parsed as JSON", async () => {
    const raw = JSON.stringify(body());

    const response = await request(createApp())
      .post("/api/webhooks/synchub/procore-project-stage-changed")
      .set("Content-Type", "text/plain")
      .set("X-SyncHub-Signature", signed(raw))
      .send(raw);

    expect(response.status).toBe(400);
    expect(response.body.error.message).toBe("Expected application/json request body");
    expect(mocks.processStageChanged).not.toHaveBeenCalled();
  });

  it("returns a controlled 400 when Content-Type is missing", async () => {
    const raw = JSON.stringify(body());

    const response = await request(createApp())
      .post("/api/webhooks/synchub/procore-project-stage-changed")
      .set("X-SyncHub-Signature", signed(raw))
      .send(raw);

    expect(response.status).toBe(400);
    expect(response.body.error.message).toBe("Expected application/json request body");
    expect(mocks.processStageChanged).not.toHaveBeenCalled();
  });
});
