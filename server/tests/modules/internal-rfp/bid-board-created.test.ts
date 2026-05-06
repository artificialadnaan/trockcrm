import crypto from "node:crypto";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/db.js", () => ({
  pool: { query: queryMock },
}));

const { internalRfpRoutes } = await import("../../../src/modules/internal-rfp/routes.js");

function app() {
  const instance = express();
  instance.use("/api/internal", internalRfpRoutes);
  return instance;
}

function sign(body: object, secret = "secret") {
  const raw = JSON.stringify(body);
  return {
    raw,
    signature: `sha256=${crypto.createHmac("sha256", secret).update(raw).digest("hex")}`,
  };
}

function body(overrides: Partial<any> = {}) {
  return {
    sourceDealId: "deal-1",
    rfpApprovalRequestId: 77,
    bidboardProjectId: "123456",
    projectNumber: "DFW-4-12345-aa",
    procoreCompanyId: "598134325683880",
    createdAt: "2026-05-06T12:00:00.000Z",
    ...overrides,
  };
}

function mockDeal(existingBidId: string | null = null) {
  queryMock.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM pg_namespace")) return { rows: [{ nspname: "office_dallas" }] };
    if (sql.includes("FROM \"office_dallas\".deals") && sql.includes("LEFT JOIN")) {
      return {
        rows: [{
          id: "deal-1",
          stage_id: "stage-1",
          company_id: null,
          primary_contact_id: null,
          procore_bid_id: existingBidId,
          stage_slug: "opportunity",
        }],
      };
    }
    return { rows: [] };
  });
}

describe("POST /api/internal/bid-board-created", () => {
  beforeEach(() => {
    queryMock.mockReset();
    process.env.SYNCHUB_SHARED_SECRET = "secret";
  });

  it("updates the CRM deal with the BidBoard hard link", async () => {
    mockDeal();
    const { raw, signature } = sign(body());

    const res = await request(app())
      .post("/api/internal/bid-board-created")
      .set("content-type", "application/json")
      .set("x-rfp-request-signature", signature)
      .send(raw);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, dealId: "deal-1", bidboardProjectId: "123456" });
    const sqlText = queryMock.mock.calls.map((call) => String(call[0])).join("\n");
    expect(sqlText).toContain("procore_bid_id = $1::bigint");
    expect(sqlText).toContain("is_bid_board_owned = true");
    expect(queryMock.mock.calls.at(-1)?.[1]).toEqual(["123456", "598134325683880", "deal-1"]);
  });

  it("treats an identical replay as a 200 idempotent success", async () => {
    mockDeal("123456");
    const { raw, signature } = sign(body());

    const first = await request(app())
      .post("/api/internal/bid-board-created")
      .set("content-type", "application/json")
      .set("x-rfp-request-signature", signature)
      .send(raw);
    const second = await request(app())
      .post("/api/internal/bid-board-created")
      .set("content-type", "application/json")
      .set("x-rfp-request-signature", signature)
      .send(raw);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });

  it("logs a discrepancy and lets the newer callback win", async () => {
    mockDeal("999999");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { raw, signature } = sign(body({ bidboardProjectId: "123456" }));

    const res = await request(app())
      .post("/api/internal/bid-board-created")
      .set("content-type", "application/json")
      .set("x-rfp-request-signature", signature)
      .send(raw);

    expect(res.status).toBe(200);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("already had procore_bid_id=999999"));
    expect(queryMock.mock.calls.at(-1)?.[1]?.[0]).toBe("123456");
    warnSpy.mockRestore();
  });

  it("returns 404 when the deal is missing", async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM pg_namespace")) return { rows: [{ nspname: "office_dallas" }] };
      return { rows: [] };
    });
    const { raw, signature } = sign(body());

    const res = await request(app())
      .post("/api/internal/bid-board-created")
      .set("content-type", "application/json")
      .set("x-rfp-request-signature", signature)
      .send(raw);

    expect(res.status).toBe(404);
  });

  it("rejects invalid HMAC signatures", async () => {
    const res = await request(app())
      .post("/api/internal/bid-board-created")
      .set("content-type", "application/json")
      .set("x-rfp-request-signature", "sha256=bad")
      .send(JSON.stringify(body()));

    expect(res.status).toBe(401);
  });
});
