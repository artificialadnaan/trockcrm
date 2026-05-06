import crypto from "crypto";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  processRelay: vi.fn(),
}));

vi.mock("./procore-project-relay-service.js", () => ({
  processSyncHubProcoreProjectCreated: mocks.processRelay,
}));

import { syncHubProcoreRelayRoutes } from "./procore-project-relay-routes.js";

function createApp() {
  const app = express();
  app.use("/api/webhooks/synchub", syncHubProcoreRelayRoutes);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status((err as any).statusCode ?? 500).json({ error: { message: err instanceof Error ? err.message : "Internal server error" } });
  });
  return app;
}

function signed(body: string, secret = "relay-secret") {
  return `sha256=${crypto.createHmac("sha256", secret).update(Buffer.from(body)).digest("hex")}`;
}

describe("SyncHub Procore project relay route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SYNCHUB_RELAY_SECRET = "relay-secret";
    delete process.env.SYNCHUB_RELAY_RECEIVER_ENABLED;
    mocks.processRelay.mockResolvedValue({ status: "linked", dealId: "deal-1", officeId: "office-1", jobId: 4 });
  });

  it("accepts a signed enriched project-created payload", async () => {
    const body = JSON.stringify({ eventType: "procore.project.created", procore: { portfolioProjectId: "123", projectNumber: "DFW-1" } });

    const response = await request(createApp())
      .post("/api/webhooks/synchub/procore-project-created")
      .set("Content-Type", "application/json")
      .set("X-SyncHub-Signature", signed(body))
      .send(body);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "linked", dealId: "deal-1", officeId: "office-1", jobId: 4 });
    expect(mocks.processRelay).toHaveBeenCalledWith(expect.objectContaining({ eventType: "procore.project.created" }));
  });

  it("rejects unsigned requests", async () => {
    const response = await request(createApp())
      .post("/api/webhooks/synchub/procore-project-created")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ eventType: "procore.project.created" }));

    expect(response.status).toBe(401);
    expect(mocks.processRelay).not.toHaveBeenCalled();
  });

  it("rejects mismatched signatures", async () => {
    const body = JSON.stringify({ eventType: "procore.project.created" });

    const response = await request(createApp())
      .post("/api/webhooks/synchub/procore-project-created")
      .set("Content-Type", "application/json")
      .set("X-SyncHub-Signature", signed(body, "wrong"))
      .send(body);

    expect(response.status).toBe(401);
    expect(mocks.processRelay).not.toHaveBeenCalled();
  });

  it("fails closed if the relay secret is missing", async () => {
    delete process.env.SYNCHUB_RELAY_SECRET;
    const body = JSON.stringify({ eventType: "procore.project.created" });

    const response = await request(createApp())
      .post("/api/webhooks/synchub/procore-project-created")
      .set("Content-Type", "application/json")
      .set("X-SyncHub-Signature", signed(body))
      .send(body);

    expect(response.status).toBe(500);
    expect(response.body.error.message).toBe("relay receiver not configured");
  });

  it("returns 503 when the emergency disable flag is false", async () => {
    process.env.SYNCHUB_RELAY_RECEIVER_ENABLED = "false";
    const body = JSON.stringify({ eventType: "procore.project.created" });

    const response = await request(createApp())
      .post("/api/webhooks/synchub/procore-project-created")
      .set("Content-Type", "application/json")
      .set("X-SyncHub-Signature", signed(body))
      .send(body);

    expect(response.status).toBe(503);
    expect(mocks.processRelay).not.toHaveBeenCalled();
  });

  it("rejects invalid JSON payloads", async () => {
    const body = "{";

    const response = await request(createApp())
      .post("/api/webhooks/synchub/procore-project-created")
      .set("Content-Type", "application/json")
      .set("X-SyncHub-Signature", signed(body))
      .send(body);

    expect(response.status).toBe(400);
    expect(mocks.processRelay).not.toHaveBeenCalled();
  });
});
