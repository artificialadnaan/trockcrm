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

function mockTenantDeal(stage = "opportunity", rfpApprovalRequestId = 11) {
  queryMock.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM pg_namespace")) return { rows: [{ nspname: "office_dallas" }] };
    if (sql.includes("FROM \"office_dallas\".deals")) {
      return {
        rows: [{
          id: "deal-1",
          stage_id: "stage-1",
          company_id: "company-1",
          primary_contact_id: "contact-1",
          rfp_approval_request_id: rfpApprovalRequestId,
          stage_slug: stage,
        }],
      };
    }
    return { rows: [] };
  });
}

describe("internal RFP routes", () => {
  beforeEach(() => {
    queryMock.mockReset();
    process.env.SYNCHUB_SHARED_SECRET = "secret";
  });

  it("checks deal eligibility with body-signed HMAC", async () => {
    mockTenantDeal("opportunity");
    const body = { sourceDealId: "deal-1" };
    const { raw, signature } = sign(body);

    const res = await request(app())
      .post("/api/internal/deals/eligibility-check")
      .set("content-type", "application/json")
      .set("x-rfp-request-signature", signature)
      .send(raw);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ exists: true, stage: "opportunity", dealId: "deal-1" });
  });

  it("returns 404 when the eligibility deal does not exist", async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM pg_namespace")) return { rows: [{ nspname: "office_dallas" }] };
      return { rows: [] };
    });
    const { raw, signature } = sign({ sourceDealId: "missing" });

    const res = await request(app())
      .post("/api/internal/deals/eligibility-check")
      .set("content-type", "application/json")
      .set("x-rfp-request-signature", signature)
      .send(raw);

    expect(res.status).toBe(404);
  });

  it("rejects eligibility requests with a bad HMAC", async () => {
    const res = await request(app())
      .post("/api/internal/deals/eligibility-check")
      .set("content-type", "application/json")
      .set("x-rfp-request-signature", "sha256=bad")
      .send(JSON.stringify({ sourceDealId: "deal-1" }));

    expect(res.status).toBe(401);
  });

  it("applies whitelisted RFP edits and rejects unknown fields", async () => {
    mockTenantDeal("opportunity");
    const body = {
      rfpApprovalRequestId: 11,
      sourceDealId: "deal-1",
      editedFields: {
        name: "Updated Deal",
        estimator: "Estimator",
        dueDate: "2026-08-01T00:00:00.000Z",
        address: { country: "US" },
        unknown: "nope",
      },
    };
    const { raw, signature } = sign(body);

    const res = await request(app())
      .post("/api/internal/rfp-edits")
      .set("content-type", "application/json")
      .set("x-rfp-request-signature", signature)
      .send(raw);

    expect(res.status).toBe(200);
    expect(res.body.applied).toEqual(expect.arrayContaining(["name", "estimator", "dueDate", "address.country"]));
    expect(res.body.rejected).toEqual(["unknown"]);
    const sqlText = queryMock.mock.calls.map((call) => String(call[0])).join("\n");
    expect(sqlText).toContain("UPDATE \"office_dallas\".deals");
    expect(sqlText).toContain("\"bid_due_date\"");
  });

  it("ignores stale RFP edits when the request id no longer matches the deal", async () => {
    mockTenantDeal("opportunity", 300);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const body = {
      rfpApprovalRequestId: 200,
      sourceDealId: "deal-1",
      editedFields: {
        name: "Stale Deal Name",
      },
    };
    const { raw, signature } = sign(body);

    const res = await request(app())
      .post("/api/internal/rfp-edits")
      .set("content-type", "application/json")
      .set("x-rfp-request-signature", signature)
      .send(raw);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      idempotent: true,
      applied: [],
      rejected: [],
      reason: "stale_callback_ignored",
    });
    const sqlText = queryMock.mock.calls.map((call) => String(call[0])).join("\n");
    expect(sqlText).not.toContain("UPDATE \"office_dallas\".deals");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("stale callback ignored"));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("incoming rfpApprovalRequestId=200"));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("current rfpApprovalRequestId=300"));
    warnSpy.mockRestore();
  });

  it("rejects invalid workflowRoute values without updating the deal", async () => {
    mockTenantDeal("opportunity");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const body = {
      rfpApprovalRequestId: 11,
      sourceDealId: "deal-1",
      editedFields: {
        workflowRoute: "frobnicate",
      },
    };
    const { raw, signature } = sign(body);

    const res = await request(app())
      .post("/api/internal/rfp-edits")
      .set("content-type", "application/json")
      .set("x-rfp-request-signature", signature)
      .send(raw);

    expect(res.status).toBe(200);
    expect(res.body.applied).not.toContain("workflowRoute");
    expect(res.body.rejected).toContain("workflowRoute");
    const sqlText = queryMock.mock.calls.map((call) => String(call[0])).join("\n");
    expect(sqlText).not.toContain("workflow_route");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("frobnicate"));
    warnSpy.mockRestore();
  });

  it("applies valid workflowRoute values", async () => {
    mockTenantDeal("opportunity");
    const body = {
      rfpApprovalRequestId: 11,
      sourceDealId: "deal-1",
      editedFields: {
        workflowRoute: "service",
      },
    };
    const { raw, signature } = sign(body);

    const res = await request(app())
      .post("/api/internal/rfp-edits")
      .set("content-type", "application/json")
      .set("x-rfp-request-signature", signature)
      .send(raw);

    expect(res.status).toBe(200);
    expect(res.body.applied).toContain("workflowRoute");
    expect(res.body.rejected).not.toContain("workflowRoute");
    const updateCall = queryMock.mock.calls.find((call) => String(call[0]).includes("UPDATE \"office_dallas\".deals"));
    expect(String(updateCall?.[0])).toContain("\"workflow_route\"");
    expect(updateCall?.[1]).toContain("service");
  });

  it("rejects projectNumber when deal_number unique constraint collides", async () => {
    mockTenantDeal("opportunity");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM pg_namespace")) return { rows: [{ nspname: "office_dallas" }] };
      if (sql.includes("FROM \"office_dallas\".deals") && !sql.includes("UPDATE")) {
        return {
          rows: [{
            id: "deal-1",
            stage_id: "stage-1",
            company_id: "company-1",
            primary_contact_id: "contact-1",
            rfp_approval_request_id: 11,
            stage_slug: "opportunity",
          }],
        };
      }
      if (sql.includes("UPDATE \"office_dallas\".deals")) {
        const error = new Error("duplicate key value violates unique constraint") as any;
        error.code = "23505";
        error.constraint = "deals_deal_number_unique";
        error.detail = "Key (deal_number)=(100) already exists.";
        throw error;
      }
      return { rows: [] };
    });
    const body = {
      rfpApprovalRequestId: 11,
      sourceDealId: "deal-1",
      editedFields: {
        projectNumber: "100",
      },
    };
    const { raw, signature } = sign(body);

    const res = await request(app())
      .post("/api/internal/rfp-edits")
      .set("content-type", "application/json")
      .set("x-rfp-request-signature", signature)
      .send(raw);

    expect(res.status).toBe(200);
    expect(res.body.applied).not.toContain("projectNumber");
    expect(res.body.rejected).toContain("projectNumber");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("deal_number collision"));
    warnSpy.mockRestore();
  });

  it("propagates non-deal_number Postgres errors from deal updates", async () => {
    mockTenantDeal("opportunity");
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM pg_namespace")) return { rows: [{ nspname: "office_dallas" }] };
      if (sql.includes("FROM \"office_dallas\".deals") && !sql.includes("UPDATE")) {
        return {
          rows: [{
            id: "deal-1",
            stage_id: "stage-1",
            company_id: "company-1",
            primary_contact_id: "contact-1",
            rfp_approval_request_id: 11,
            stage_slug: "opportunity",
          }],
        };
      }
      if (sql.includes("UPDATE \"office_dallas\".deals")) {
        const error = new Error("database unavailable") as any;
        error.code = "57P01";
        throw error;
      }
      return { rows: [] };
    });
    const body = {
      rfpApprovalRequestId: 11,
      sourceDealId: "deal-1",
      editedFields: {
        name: "Updated Deal",
      },
    };
    const { raw, signature } = sign(body);

    const res = await request(app())
      .post("/api/internal/rfp-edits")
      .set("content-type", "application/json")
      .set("x-rfp-request-signature", signature)
      .send(raw);

    expect(res.status).toBe(500);
  });

  it("rejects edit requests with a bad HMAC", async () => {
    const res = await request(app())
      .post("/api/internal/rfp-edits")
      .set("content-type", "application/json")
      .set("x-rfp-request-signature", "sha256=bad")
      .send(JSON.stringify({ sourceDealId: "deal-1", editedFields: {} }));

    expect(res.status).toBe(401);
  });
});
