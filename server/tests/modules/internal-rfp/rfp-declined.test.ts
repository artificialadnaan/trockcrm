import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.hoisted(() => vi.fn());
const clientReleaseMock = vi.hoisted(() => vi.fn());
const DEAL_ID = "11111111-1111-4111-8111-111111111111";

vi.mock("../../../src/db.js", () => ({
  releasePooledClient: (client: any) => client?.release?.(),
  pool: {
    query: queryMock,
    connect: vi.fn(async () => ({ query: queryMock, release: clientReleaseMock })),
  },
}));

const { internalRfpRoutes } = await import("../../../src/modules/internal-rfp/routes.js");

function findRouteHandler(method: "post", path: string) {
  const layer = (internalRfpRoutes as any).stack.find(
    (entry: any) => entry.route?.path === path && entry.route?.methods?.[method]
  );
  if (!layer) throw new Error(`Route ${method.toUpperCase()} ${path} not found`);
  const routeLayer = [...layer.route.stack].reverse().find((entry: any) => entry.method === method);
  if (!routeLayer) throw new Error(`Route handler ${method.toUpperCase()} ${path} not found`);
  return routeLayer.handle;
}

function makeRes() {
  return {
    statusCode: 200,
    body: undefined as any,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: any) {
      this.body = payload;
      return this;
    },
  } as any;
}

async function callDeclineRoute(raw: string, signature?: string) {
  return callDeclineRouteWithBody(Buffer.from(raw), signature);
}

async function callDeclineRouteWithBody(body: unknown, signature?: string) {
  const req = {
    body,
    headers: signature ? { "x-rfp-request-signature": signature } : {},
  } as any;
  const res = makeRes();
  const next = vi.fn();
  await findRouteHandler("post", "/rfp-declined")(req, res, next);
  expect(next).not.toHaveBeenCalled();
  return res;
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
    sourceDealId: DEAL_ID,
    rfpApprovalRequestId: 77,
    denialReason: "Pricing was too high",
    declinedAt: "2026-05-26T15:30:00.000Z",
    ...overrides,
  };
}

function mockDeal(options: {
  rfpApprovalStatus?: string | null;
  rfpApprovalRequestId?: number | null;
  assignedRepId?: string | null;
  requestedBy?: string | null;
  updateRowCount?: number;
} = {}) {
  const {
    rfpApprovalStatus = "pending",
    rfpApprovalRequestId = 77,
    assignedRepId = "rep-1",
    requestedBy = "user-rfp",
    updateRowCount,
  } = options;
  let dealLookupCount = 0;

  queryMock.mockImplementation(async (sql: string, values?: unknown[]) => {
    if (sql.includes("FROM pg_namespace")) return { rows: [{ nspname: "office_dallas" }] };
    if (sql.includes("FROM \"office_dallas\".deals") && sql.includes("LEFT JOIN")) {
      dealLookupCount += 1;
      const effectiveStatus = updateRowCount === 0 && dealLookupCount > 1 ? "declined" : rfpApprovalStatus;
      return {
        rows: [{
          id: DEAL_ID,
          name: "Austin Center",
          deal_number: "DFW-4-12345-aa",
          project_number: null,
          stage_id: "stage-1",
          company_id: null,
          primary_contact_id: null,
          procore_bid_id: null,
          procore_company_id: null,
          is_bid_board_owned: false,
          rfp_approval_status: effectiveStatus,
          rfp_declined_reason: null,
          rfp_declined_at: null,
          bid_board_linked_at: null,
          assigned_rep_id: assignedRepId,
          rfp_approval_requested_by: requestedBy,
          rfp_approval_request_id: rfpApprovalRequestId,
          workflow_route: "normal",
          stage_entered_at: "2026-05-01T00:00:00.000Z",
          on_hold: false,
          on_hold_started_at: null,
          on_hold_accumulated_seconds: 0,
          on_hold_accumulated_seconds_at_stage_entry: 0,
          stage_slug: "opportunity",
          stage_display_order: 2,
          stage_is_terminal: false,
        }],
      };
    }
    if (sql.includes("UPDATE \"office_dallas\".deals") && sql.includes("rfp_approval_status = 'declined'")) {
      return {
        rows: [{
          id: DEAL_ID,
          name: "Austin Center",
          deal_number: "DFW-4-12345-aa",
          project_number: null,
          rfp_approval_status: "declined",
          rfp_declined_reason: values?.[0] ?? "Pricing was too high",
          rfp_declined_at: values?.[1] ?? "2026-05-26T15:30:00.000Z",
        }],
        rowCount: updateRowCount ?? (rfpApprovalStatus === "declined" ? 0 : 1),
      };
    }
    if (sql.includes("INSERT INTO \"office_dallas\".deal_history")) return { rows: [], rowCount: 1 };
    if (sql.includes("INSERT INTO \"office_dallas\".audit_log")) return { rows: [], rowCount: 1 };
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
    return { rows: [], rowCount: 0 };
  });
}

describe("POST /api/internal/rfp-declined", () => {
  beforeEach(() => {
    queryMock.mockReset();
    clientReleaseMock.mockReset();
    process.env.SYNCHUB_SHARED_SECRET = "secret";
  });

  it("sets the deal to declined with the reason and timestamp", async () => {
    mockDeal();
    const { raw, signature } = sign(body());

    const res = await callDeclineRoute(raw, signature);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      success: true,
      dealId: DEAL_ID,
      status: "declined",
      pending: false,
    });

    const updateCall = queryMock.mock.calls.find((call) =>
      String(call[0]).includes("UPDATE \"office_dallas\".deals") &&
      String(call[0]).includes("rfp_approval_status = 'declined'")
    );
    expect(String(updateCall?.[0])).toContain("rfp_declined_reason");
    expect(String(updateCall?.[0])).toContain("rfp_declined_at");
    expect(String(updateCall?.[0])).toContain("rfp_approval_status IN ('pending_outbox', 'pending')");
    expect(updateCall?.[1]).toEqual(["Pricing was too high", "2026-05-26T15:30:00.000Z", DEAL_ID, 77]);
  });

  it("writes audit and deal_history entries", async () => {
    mockDeal();
    const { raw, signature } = sign(body());

    const res = await callDeclineRoute(raw, signature);

    expect(res.statusCode).toBe(200);
    const auditCall = queryMock.mock.calls.find((call) => String(call[0]).includes("INSERT INTO \"office_dallas\".audit_log"));
    expect(auditCall?.[1]).toEqual(expect.arrayContaining([
      "deals",
      DEAL_ID,
      "update",
      "Internal RFP Receiver",
      "Austin Center",
      "DFW-4-12345-aa",
    ]));
    const historyCall = queryMock.mock.calls.find((call) => String(call[0]).includes("INSERT INTO \"office_dallas\".deal_history"));
    expect(historyCall?.[1]).toEqual([
      DEAL_ID,
      "rfp_approval_status",
      "pending",
      "declined",
      "user-rfp",
      "internal_rfp_decline_callback",
      "Pricing was too high",
      "2026-05-26T15:30:00.000Z",
    ]);
  });

  it("treats a duplicate decline callback as an idempotent success", async () => {
    mockDeal({ rfpApprovalStatus: "declined" });
    const { raw, signature } = sign(body());

    const res = await callDeclineRoute(raw, signature);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      success: true,
      idempotent: true,
      dealId: DEAL_ID,
      status: "declined",
      pending: false,
    });
    const sqlText = queryMock.mock.calls.map((call) => String(call[0])).join("\n");
    expect(sqlText).not.toContain("INSERT INTO \"office_dallas\".deal_history");
  });

  it("treats a same-request decline race as an idempotent success when the deal is already declined after re-read", async () => {
    mockDeal({ rfpApprovalStatus: "pending", updateRowCount: 0 });
    const { raw, signature } = sign(body());

    const res = await callDeclineRoute(raw, signature);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      success: true,
      idempotent: true,
      dealId: DEAL_ID,
      status: "declined",
      pending: false,
    });
    const dealLookups = queryMock.mock.calls.filter((call) =>
      String(call[0]).includes("FROM \"office_dallas\".deals") && String(call[0]).includes("LEFT JOIN")
    );
    expect(dealLookups).toHaveLength(2);
  });

  it("returns a typed not-found response for an unknown deal", async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM pg_namespace")) return { rows: [{ nspname: "office_dallas" }] };
      return { rows: [] };
    });
    const { raw, signature } = sign(body());

    const res = await callDeclineRoute(raw, signature);

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ success: false, error: "deal_not_found" });
  });

  it("returns a typed invalid-payload response for a malformed deal id", async () => {
    const { raw, signature } = sign(body({ sourceDealId: "not-a-uuid" }));

    const res = await callDeclineRoute(raw, signature);

    expect(res.statusCode).toBe(422);
    expect(res.body).toEqual({ success: false, error: "invalid_payload" });
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("returns a typed invalid-payload response for signed non-object JSON", async () => {
    const raw = "null";
    const signature = `sha256=${crypto.createHmac("sha256", "secret").update(raw).digest("hex")}`;

    const res = await callDeclineRoute(raw, signature);

    expect(res.statusCode).toBe(422);
    expect(res.body).toEqual({ success: false, error: "invalid_payload" });
  });

  it("returns a typed error instead of a 500 when the raw body is not a Buffer", async () => {
    const res = await callDeclineRouteWithBody(undefined, "sha256=bad");

    expect(res.statusCode).toBe(422);
    expect(res.body).toEqual({ success: false, error: "invalid_payload" });
    expect(queryMock).not.toHaveBeenCalled();
  });

  it.each([
    ["non-finite", `{"sourceDealId":"${DEAL_ID}","rfpApprovalRequestId":1e999,"denialReason":"No","declinedAt":"2026-05-26T15:30:00.000Z"}`],
    ["non-integer", `{"sourceDealId":"${DEAL_ID}","rfpApprovalRequestId":77.5,"denialReason":"No","declinedAt":"2026-05-26T15:30:00.000Z"}`],
  ])("returns invalid-payload for a %s request id", async (_label, raw) => {
    const signature = `sha256=${crypto.createHmac("sha256", "secret").update(raw).digest("hex")}`;

    const res = await callDeclineRoute(raw, signature);

    expect(res.statusCode).toBe(422);
    expect(res.body).toEqual({ success: false, error: "invalid_payload" });
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("falls back to reason when denialReason is blank", async () => {
    mockDeal();
    const { raw, signature } = sign(body({ denialReason: "   ", reason: "Approver declined: missing scope" }));

    const res = await callDeclineRoute(raw, signature);

    expect(res.statusCode).toBe(200);
    const updateCall = queryMock.mock.calls.find((call) =>
      String(call[0]).includes("UPDATE \"office_dallas\".deals") &&
      String(call[0]).includes("rfp_approval_status = 'declined'")
    );
    expect(updateCall?.[1]?.[0]).toBe("Approver declined: missing scope");
    const historyCall = queryMock.mock.calls.find((call) => String(call[0]).includes("INSERT INTO \"office_dallas\".deal_history"));
    expect(historyCall?.[1]?.[6]).toBe("Approver declined: missing scope");
  });

  it("rejects non-string denial reasons instead of stringifying them", async () => {
    const { raw, signature } = sign(body({ denialReason: { nested: "nope" } }));

    const res = await callDeclineRoute(raw, signature);

    expect(res.statusCode).toBe(422);
    expect(res.body).toEqual({ success: false, error: "invalid_payload" });
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("rejects non-string fallback reasons instead of stringifying them", async () => {
    const { raw, signature } = sign(body({ denialReason: "", reason: { nested: "nope" } }));

    const res = await callDeclineRoute(raw, signature);

    expect(res.statusCode).toBe(422);
    expect(res.body).toEqual({ success: false, error: "invalid_payload" });
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("does not treat a declined deal with a different request id as a duplicate", async () => {
    mockDeal({ rfpApprovalStatus: "declined", rfpApprovalRequestId: 88 });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { raw, signature } = sign(body({ rfpApprovalRequestId: 77 }));

    const res = await callDeclineRoute(raw, signature);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      success: true,
      idempotent: true,
      reason: "stale_callback_ignored",
    });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("stale callback ignored"));
    warnSpy.mockRestore();
  });

  it("returns a typed invalid-state response when no RFP is pending", async () => {
    mockDeal({ rfpApprovalStatus: null, rfpApprovalRequestId: null });
    const { raw, signature } = sign(body());

    const res = await callDeclineRoute(raw, signature);

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({
      success: false,
      error: "rfp_decline_invalid_state",
      reason: "no_pending_rfp",
    });
  });

  it("rejects unsigned requests", async () => {
    const res = await callDeclineRoute(JSON.stringify(body()));

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ success: false, error: "invalid_signature" });
  });
});
