import crypto from "node:crypto";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/db.js", () => ({
  pool: {
    query: queryMock,
    connect: vi.fn(async () => ({ query: queryMock, release: vi.fn() })),
  },
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

function mockDeal(
  existingBidId: string | null = null,
  rfpApprovalRequestId = 77,
  workflowRoute: "normal" | "service" = "normal"
) {
  queryMock.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM pg_namespace")) return { rows: [{ nspname: "office_dallas" }] };
    if (sql.includes("FROM \"office_dallas\".deals") && sql.includes("LEFT JOIN")) {
      return {
        rows: [{
          id: "deal-1",
          name: "Austin Center",
          deal_number: "DFW-4-12345-aa",
          project_number: null,
          stage_id: "stage-1",
          company_id: null,
          primary_contact_id: null,
          procore_bid_id: existingBidId,
          procore_company_id: null,
          is_bid_board_owned: false,
          rfp_approval_status: "requested",
          bid_board_linked_at: null,
          assigned_rep_id: "rep-1",
          rfp_approval_requested_by: "user-rfp",
          rfp_approval_request_id: rfpApprovalRequestId,
          workflow_route: workflowRoute,
          stage_entered_at: "2026-05-01T00:00:00.000Z",
          stage_slug: "opportunity",
          stage_display_order: 2,
          stage_is_terminal: false,
        }],
      };
    }
    if (sql.includes("FROM public.pipeline_stage_config") && sql.includes("slug = $1")) {
      const slug = queryMock.mock.calls.at(-1)?.[1]?.[0];
      return { rows: [{ id: `${slug}-stage`, display_order: 3, is_terminal: false }] };
    }
    if (sql.includes("UPDATE \"office_dallas\".deals")) return { rows: [], rowCount: 1 };
    if (sql.includes("INSERT INTO \"office_dallas\".deal_stage_history")) return { rows: [], rowCount: 1 };
    return { rows: [], rowCount: 0 };
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
    const updateCall = queryMock.mock.calls.find((call) => String(call[0]).includes("UPDATE \"office_dallas\".deals"));
    expect(updateCall?.[1]).toContain("123456");
    expect(updateCall?.[1]).toContain("598134325683880");
    expect(updateCall?.[1]).toContain("deal-1");
    const auditCalls = queryMock.mock.calls.filter((call) => String(call[0]).includes("INSERT INTO \"office_dallas\".audit_log"));
    expect(auditCalls.length).toBeGreaterThanOrEqual(1);
    expect(auditCalls[0]?.[1]).toEqual(expect.arrayContaining([
      "deals",
      "deal-1",
      "update",
      "Internal RFP Receiver",
      "Austin Center",
      "DFW-4-12345-aa",
    ]));
  });

  it("moves normal-route deals to estimating when linked", async () => {
    mockDeal(null, 77, "normal");
    const { raw, signature } = sign(body());

    const res = await request(app())
      .post("/api/internal/bid-board-created")
      .set("content-type", "application/json")
      .set("x-rfp-request-signature", signature)
      .send(raw);

    expect(res.status).toBe(200);
    const stageLookup = queryMock.mock.calls.find((call) => String(call[0]).includes("slug = $1"));
    expect(stageLookup?.[1]).toEqual(["estimating"]);
    const updateCall = queryMock.mock.calls.find((call) => String(call[0]).includes("stage_id = $1::uuid"));
    const updateSql = String(updateCall?.[0]);
    const updateValues = updateCall?.[1];
    expect(updateSql).toContain("stage_id");
    expect(updateSql).toContain("stage_entered_at");
    expect(updateValues).toContain("estimating-stage");
    const historyCall = queryMock.mock.calls.find((call) => String(call[0]).includes("INSERT INTO \"office_dallas\".deal_stage_history"));
    expect(historyCall?.[1]).toEqual([
      "deal-1",
      "stage-1",
      "estimating-stage",
      "user-rfp",
      "Bid Board created callback - Stage estimating",
      "2026-05-01T00:00:00.000Z",
    ]);
  });

  it("moves service-route deals to service_estimating when linked", async () => {
    mockDeal(null, 77, "service");
    const { raw, signature } = sign(body());

    const res = await request(app())
      .post("/api/internal/bid-board-created")
      .set("content-type", "application/json")
      .set("x-rfp-request-signature", signature)
      .send(raw);

    expect(res.status).toBe(200);
    const stageLookup = queryMock.mock.calls.find((call) => String(call[0]).includes("slug = $1"));
    expect(stageLookup?.[1]).toEqual(["service_estimating"]);
    const updateCall = queryMock.mock.calls.find((call) => String(call[0]).includes("stage_id = $1::uuid"));
    const updateSql = String(updateCall?.[0]);
    const updateValues = updateCall?.[1];
    expect(updateSql).toContain("stage_id");
    expect(updateSql).toContain("stage_entered_at");
    expect(updateValues).toContain("service_estimating-stage");
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
    const updateCall = queryMock.mock.calls.find((call) => String(call[0]).includes("UPDATE \"office_dallas\".deals"));
    expect(updateCall?.[1]?.[0]).toBe("123456");
    warnSpy.mockRestore();
  });

  it("acknowledges and ignores a stale callback for an older approval request", async () => {
    mockDeal("999999", 200);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { raw, signature } = sign(body({ rfpApprovalRequestId: 100, bidboardProjectId: "123456" }));

    const res = await request(app())
      .post("/api/internal/bid-board-created")
      .set("content-type", "application/json")
      .set("x-rfp-request-signature", signature)
      .send(raw);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      idempotent: true,
      reason: "stale_callback_ignored",
    });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("stale callback"));
    const sqlText = queryMock.mock.calls.map((call) => String(call[0])).join("\n");
    expect(sqlText).not.toContain("SET procore_bid_id");
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
