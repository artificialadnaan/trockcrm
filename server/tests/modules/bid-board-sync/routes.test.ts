import crypto from "crypto";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const serviceMocks = vi.hoisted(() => ({
  ingestBidBoardRows: vi.fn(),
}));

vi.mock("../../../src/modules/bid-board-sync/service.js", () => ({
  ingestBidBoardRows: serviceMocks.ingestBidBoardRows,
}));

const { bidBoardSyncRoutes } = await import("../../../src/modules/bid-board-sync/routes.js");
const { errorHandler } = await import("../../../src/middleware/error-handler.js");

function createApp() {
  const app = express();
  app.use("/api/bid-board-sync", bidBoardSyncRoutes);
  app.use(errorHandler);
  return app;
}

function sign(body: string, secret = "bid-board-secret") {
  return `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
}

describe("POST /api/bid-board-sync/ingest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.BID_BOARD_SYNC_SECRET = "bid-board-secret";
    serviceMocks.ingestBidBoardRows.mockResolvedValue({
      runId: "run-1",
      metrics: { rowsReceived: 1, updated: 1, noMatch: 0, multiMatch: 0, warnings: 0 },
    });
  });

  it("rejects missing signatures with 401", async () => {
    const body = JSON.stringify({ rows: [], provenance: { sourceFilename: "ProjectList.xlsx" } });

    const res = await request(createApp())
      .post("/api/bid-board-sync/ingest")
      .set("content-type", "application/json")
      .send(body);

    expect(res.status).toBe(401);
    expect(serviceMocks.ingestBidBoardRows).not.toHaveBeenCalled();
  });

  it("rejects invalid signatures with 401", async () => {
    const body = JSON.stringify({ rows: [], provenance: { sourceFilename: "ProjectList.xlsx" } });

    const res = await request(createApp())
      .post("/api/bid-board-sync/ingest")
      .set("content-type", "application/json")
      .set("x-bid-board-sync-signature", sign(body, "wrong-secret"))
      .send(body);

    expect(res.status).toBe(401);
    expect(serviceMocks.ingestBidBoardRows).not.toHaveBeenCalled();
  });

  it("accepts a valid HMAC signature and passes parsed payload to the service", async () => {
    const payload = {
      office_slug: "dallas",
      provenance: {
        sourceFilename: "ProjectList.xlsx",
        extractedAt: "2026-04-28T14:15:00.000Z",
      },
      rows: [{ Name: "Palm Villas", Status: "Estimate in Progress", "Project #": "DFW-4-11826-ab" }],
    };
    const body = JSON.stringify(payload);

    const res = await request(createApp())
      .post("/api/bid-board-sync/ingest")
      .set("content-type", "application/json")
      .set("x-bid-board-sync-signature", sign(body))
      .send(body);

    expect(res.status).toBe(202);
    expect(serviceMocks.ingestBidBoardRows).toHaveBeenCalledWith(payload);
    expect(res.body.metrics.updated).toBe(1);
  });
});
