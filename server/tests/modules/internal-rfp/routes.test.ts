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

function mockTenantDeal(stage = "opportunity") {
  queryMock.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM pg_namespace")) return { rows: [{ nspname: "office_dallas" }] };
    if (sql.includes("FROM \"office_dallas\".deals")) {
      return {
        rows: [{
          id: "deal-1",
          stage_id: "stage-1",
          company_id: "company-1",
          primary_contact_id: "contact-1",
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

  it("rejects edit requests with a bad HMAC", async () => {
    const res = await request(app())
      .post("/api/internal/rfp-edits")
      .set("content-type", "application/json")
      .set("x-rfp-request-signature", "sha256=bad")
      .send(JSON.stringify({ sourceDealId: "deal-1", editedFields: {} }));

    expect(res.status).toBe(401);
  });
});
