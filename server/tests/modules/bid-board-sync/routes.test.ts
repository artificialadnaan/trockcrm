import crypto from "crypto";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The route now ACCEPTS + enqueues (fast, idempotent) instead of running the whole import synchronously.
// Mock the durable inbox layer + db pool so these stay HTTP-contract unit tests; the real enqueue/state
// machine is covered in inbox.runtime.test.ts.
const inboxMocks = vi.hoisted(() => ({
  acceptBidBoardIngestion: vi.fn(),
  readInboxStatusByKey: vi.fn(),
}));

vi.mock("../../../src/db.js", () => ({ pool: { query: vi.fn() } }));

vi.mock("../../../src/modules/bid-board-sync/inbox.js", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual, // keep the real computeIdempotencyKey / extractOfficeSlug the route relies on
    acceptBidBoardIngestion: inboxMocks.acceptBidBoardIngestion,
    readInboxStatusByKey: inboxMocks.readInboxStatusByKey,
  };
});

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
const sha256 = (body: string) => crypto.createHash("sha256").update(body).digest("hex");

describe("POST /api/bid-board-sync/ingest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.BID_BOARD_SYNC_SECRET = "bid-board-secret";
    inboxMocks.acceptBidBoardIngestion.mockResolvedValue({
      inboxId: "inbox-1",
      status: "queued",
      duplicate: false,
      idempotencyKey: "will-be-overwritten",
    });
  });

  it("rejects missing signatures with 401 and never enqueues", async () => {
    const body = JSON.stringify({ office_slug: "dallas", rows: [] });
    const res = await request(createApp())
      .post("/api/bid-board-sync/ingest")
      .set("content-type", "application/json")
      .send(body);
    expect(res.status).toBe(401);
    expect(inboxMocks.acceptBidBoardIngestion).not.toHaveBeenCalled();
  });

  it("rejects invalid signatures with 401", async () => {
    const body = JSON.stringify({ office_slug: "dallas", rows: [] });
    const res = await request(createApp())
      .post("/api/bid-board-sync/ingest")
      .set("content-type", "application/json")
      .set("x-bid-board-sync-signature", sign(body, "wrong-secret"))
      .send(body);
    expect(res.status).toBe(401);
    expect(inboxMocks.acceptBidBoardIngestion).not.toHaveBeenCalled();
  });

  it("rejects a missing/invalid office_slug with 400", async () => {
    const body = JSON.stringify({ rows: [] });
    const res = await request(createApp())
      .post("/api/bid-board-sync/ingest")
      .set("content-type", "application/json")
      .set("x-bid-board-sync-signature", sign(body))
      .send(body);
    expect(res.status).toBe(400);
    expect(inboxMocks.acceptBidBoardIngestion).not.toHaveBeenCalled();
  });

  it("ACKNOWLEDGES with 202 promptly by enqueuing (does not run the import inline)", async () => {
    const payload = {
      office_slug: "dallas",
      provenance: { sourceFilename: "ProjectList.xlsx", extractedAt: "2026-04-28T14:15:00.000Z", rowCount: 1 },
      rows: [{ Name: "Palm Villas", Status: "Estimate in Progress", "Project #": "DFW-4-11826-ab" }],
    };
    const body = JSON.stringify(payload);
    inboxMocks.acceptBidBoardIngestion.mockResolvedValue({
      inboxId: "inbox-42",
      status: "queued",
      duplicate: false,
      idempotencyKey: sha256(body),
    });

    const res = await request(createApp())
      .post("/api/bid-board-sync/ingest")
      .set("content-type", "application/json")
      .set("x-bid-board-sync-signature", sign(body))
      .send(body);

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      accepted: true,
      jobId: "inbox-42",
      status: "queued",
      duplicate: false,
      idempotencyKey: sha256(body),
    });
    // Enqueued with the office + the sha256(body) idempotency key derived from the raw bytes.
    expect(inboxMocks.acceptBidBoardIngestion).toHaveBeenCalledTimes(1);
    const arg = inboxMocks.acceptBidBoardIngestion.mock.calls[0][1];
    expect(arg).toMatchObject({
      officeSlug: "dallas",
      payloadHash: sha256(body),
      rowCount: 1,
      sourceFilename: "ProjectList.xlsx",
    });
  });

  it("surfaces an idempotent duplicate (already queued/processing) as 202 with duplicate:true", async () => {
    const body = JSON.stringify({ office_slug: "dallas", rows: [] });
    inboxMocks.acceptBidBoardIngestion.mockResolvedValue({
      inboxId: "inbox-1",
      status: "processing",
      duplicate: true,
      idempotencyKey: sha256(body),
    });
    const res = await request(createApp())
      .post("/api/bid-board-sync/ingest")
      .set("content-type", "application/json")
      .set("x-bid-board-sync-signature", sign(body))
      .send(body);
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ accepted: true, duplicate: true, status: "processing" });
  });
});

describe("POST /api/bid-board-sync/ingest/status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.BID_BOARD_SYNC_SECRET = "bid-board-secret";
  });

  it("rejects an unsigned status probe with 401", async () => {
    const body = JSON.stringify({ office_slug: "dallas", idempotency_key: "abc" });
    const res = await request(createApp())
      .post("/api/bid-board-sync/ingest/status")
      .set("content-type", "application/json")
      .send(body);
    expect(res.status).toBe(401);
    expect(inboxMocks.readInboxStatusByKey).not.toHaveBeenCalled();
  });

  it("returns the durable status for a known key", async () => {
    inboxMocks.readInboxStatusByKey.mockResolvedValue({
      id: "inbox-9",
      status: "succeeded",
      attempts: 1,
      max_attempts: 5,
      run_id: "run-9",
      warnings_count: 0,
      last_error: null,
      queued_at: "2026-07-19T06:16:00.000Z",
      started_at: "2026-07-19T06:16:01.000Z",
      finished_at: "2026-07-19T06:16:05.000Z",
      updated_at: "2026-07-19T06:16:05.000Z",
    });
    const body = JSON.stringify({ office_slug: "dallas", idempotency_key: "abc" });
    const res = await request(createApp())
      .post("/api/bid-board-sync/ingest/status")
      .set("content-type", "application/json")
      .set("x-bid-board-sync-signature", sign(body))
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "succeeded", jobId: "inbox-9", idempotencyKey: "abc" });
  });

  it("returns status 'unknown' for a key the CRM never saw (POST never landed)", async () => {
    inboxMocks.readInboxStatusByKey.mockResolvedValue(null);
    const body = JSON.stringify({ office_slug: "dallas", idempotency_key: "never" });
    const res = await request(createApp())
      .post("/api/bid-board-sync/ingest/status")
      .set("content-type", "application/json")
      .set("x-bid-board-sync-signature", sign(body))
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "unknown", idempotencyKey: "never" });
  });
});
