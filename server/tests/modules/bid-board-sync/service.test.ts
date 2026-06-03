import { describe, expect, it, vi } from "vitest";

const {
  buildBidBoardDealUpdateSql,
  findDealIds,
  normalizeBidBoardRow,
  parseBidBoardDueDate,
  normalizeBidBoardProjectNumber,
  updateParams,
} = await import("../../../src/modules/bid-board-sync/service.js");

describe("Bid Board sync service", () => {
  it("rejects anomalous due-date years to null with a warning", () => {
    const parsed = parseBidBoardDueDate("1/15/2099", "Future Project");

    expect(parsed.value).toBeNull();
    expect(parsed.warning).toContain("outside accepted range");
  });

  it("accepts normal due dates as YYYY-MM-DD", () => {
    const parsed = parseBidBoardDueDate("4/30/2026", "Normal Project");

    expect(parsed.value).toBe("2026-04-30");
    expect(parsed.warning).toBeNull();
  });

  it("normalizes the Bid Board fields without touching CRM-managed fields", () => {
    const normalized = normalizeBidBoardRow({
      Name: "Palm Villas",
      "Project ID": "123456",
      Estimator: "Brett Bell",
      Office: "T-Rock Construction LLC",
      Status: "Estimate in Progress",
      "Sales Price Per Area": "$ 0 /sq ft",
      "Project Cost": "$1,234.56",
      "Profit Margin": "30%",
      "Total Sales": "$9,876.54",
      "Created Date": "2026-04-01T12:34:56.123456Z",
      "Due Date": "4/30/2026",
      "Customer Name": "Palm Holdings",
      "Customer Contact": "Jane Buyer, 214-555-0101, jane@example.com",
      "Project #": "DFW-4-11826-ab",
      assigned_rep_id: "must-not-pass-through",
      awarded_amount: "must-not-pass-through",
      stage_id: "must-not-pass-through",
    });

    expect(normalized).toMatchObject({
      name: "Palm Villas",
      bidBoardProjectId: "123456",
      bidBoardEstimator: "Brett Bell",
      bidBoardOffice: "T-Rock Construction LLC",
      bidBoardStatus: "Estimate in Progress",
      bidBoardSalesPricePerArea: "$ 0 /sq ft",
      bidBoardProjectCost: "1234.56",
      bidBoardProfitMarginPct: "30",
      bidBoardTotalSales: "9876.54",
      bidBoardCreatedAt: "2026-04-01T12:34:56.123456Z",
      bidBoardDueDate: "2026-04-30",
      bidBoardCustomerName: "Palm Holdings",
      bidBoardCustomerContactRaw: "Jane Buyer, 214-555-0101, jane@example.com",
      bidBoardProjectNumber: "DFW-4-11826-ab",
    });
    expect(Object.keys(normalized)).not.toContain("assigned_rep_id");
    expect(Object.keys(normalized)).not.toContain("awarded_amount");
    expect(Object.keys(normalized)).not.toContain("stage_id");
  });

  it("builds guarded update SQL that only touches the mirrored Bid Board fields", () => {
    const query = buildBidBoardDealUpdateSql("office_dallas");
    const lower = query.toLowerCase();

    expect(lower).toContain("update office_dallas.deals");
    expect(lower).toContain("bid_board_project_number");
    expect(lower).toContain("is distinct from");
    expect(lower).toContain("updated_at = now()");
    expect(lower).not.toContain("stage_id =");
    expect(lower).not.toContain("assigned_rep_id");
    expect(lower).not.toContain("awarded_amount");
  });

  it("sets Bid Board last-updated from the ingestion cycle timestamp", () => {
    const query = buildBidBoardDealUpdateSql("office_dallas");
    const lower = query.toLowerCase();

    expect(lower).toContain("bid_board_last_updated_at = $15::timestamptz");
    expect(lower).toContain("bid_board_last_updated_at is distinct from $15::timestamptz");
  });

  it("matches by stored Procore Bid Board id before project number", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ id: "deal-123" }] });
    const normalized = normalizeBidBoardRow({
      Name: "Palm Villas",
      "Project ID": "987654",
      "Project #": "DFW-4-11826-ab",
      Status: "Estimate in Progress",
    });

    const ids = await findDealIds({ query }, "office_dallas", normalized);

    expect(ids).toEqual(["deal-123"]);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain("procore_bid_id = $1::bigint");
    expect(query.mock.calls[0][1]).toEqual(["987654"]);
  });

  it("falls back to project number when the Bid Board id is not numeric", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ id: "deal-by-project-number" }] });
    const normalized = normalizeBidBoardRow({
      Name: "Palm Villas",
      "Project ID": "not-a-number",
      "Project #": "DFW-4-11826-ab",
      Status: "Estimate in Progress",
    });

    const ids = await findDealIds({ query }, "office_dallas", normalized);

    expect(ids).toEqual(["deal-by-project-number"]);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain("project_number");
    expect(query.mock.calls[0][0]).toContain("deal_number");
    expect(query.mock.calls[0][0]).toContain("bid_board_project_number");
    expect(query.mock.calls[0][1]).toEqual(["dfw-4-11826-ab"]);
  });

  it("matches on the canonical project number on BOTH sides (incoming + column) so dash/NBSP variants match legacy stored values", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ id: "deal-canonical" }] });
    const enDash = String.fromCharCode(0x2013);
    const normalized = normalizeBidBoardRow({
      Name: "Palm Villas",
      "Project #": `DFW${enDash}4${enDash}11826-AB`,
      Status: "Estimate in Progress",
    });

    const ids = await findDealIds({ query }, "office_dallas", normalized);

    expect(ids).toEqual(["deal-canonical"]);
    const sql = String(query.mock.calls[0][0]).toLowerCase();
    // columns are canonicalized in SQL (not just LOWER(TRIM)), so a stored Unicode-dash
    // value still matches the canonicalized incoming param.
    expect(sql).toContain("translate(");
    expect(sql).toContain("normalize(d.project_number, nfc)");
    expect(sql).toContain("normalize(d.deal_number, nfc)");
    expect(sql).toContain("normalize(d.bid_board_project_number, nfc)");
    // incoming param is the canonical form of the en-dash value
    expect(query.mock.calls[0][1]).toEqual(["dfw-4-11826-ab"]);
  });

  it("normalizes Bid Board Project # tokens for case-insensitive CRM matching", () => {
    expect(normalizeBidBoardProjectNumber("  DFW-4-11826-ab  ")).toBe("dfw-4-11826-ab");
    expect(normalizeBidBoardProjectNumber("\t")).toBeNull();
  });

  it("canonicalizes Bid Board Project # dashes/NBSP/case so visually-identical values match", () => {
    const emDash = String.fromCharCode(0x2014);
    const enDash = String.fromCharCode(0x2013);
    const nbsp = String.fromCharCode(0x00a0);
    // Unicode dashes fold to ASCII hyphen
    expect(normalizeBidBoardProjectNumber(`DFW${emDash}4${enDash}11826-AB`)).toBe("dfw-4-11826-ab");
    // NBSP is stripped (surrounding or internal)
    expect(normalizeBidBoardProjectNumber(`DFW-4-11826-ab${nbsp}`)).toBe("dfw-4-11826-ab");
    // a genuinely different suffix still does NOT collide
    expect(normalizeBidBoardProjectNumber("DFW-4-11826-ai")).not.toBe(
      normalizeBidBoardProjectNumber("DFW-4-11826-ab")
    );
  });

  it("passes the latest ingestion cycle timestamp into the deal update", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ id: "deal-123" }] });
    const normalized = normalizeBidBoardRow({
      Name: "Palm Villas",
      "Project ID": "987654",
      Status: "Estimate in Progress",
    });
    const params = updateParams("deal-123", normalized, "2026-05-06T16:30:00.000Z", null);

    // $15 (index 14) is the cycle timestamp; $16 (last) is the estimator_user_id.
    expect(params[14]).toBe("2026-05-06T16:30:00.000Z");
    await findDealIds({ query }, "office_dallas", normalized);
    const newerParams = updateParams("deal-123", normalized, "2026-05-06T16:45:00.000Z", null);
    expect(newerParams[14]).toBe("2026-05-06T16:45:00.000Z");
  });

  it("writes the (resolved + validated) estimator_user_id at $16, or null, into the deal update", () => {
    const sql = buildBidBoardDealUpdateSql("office_dallas").toLowerCase();
    expect(sql).toContain("estimator_user_id = $16");
    expect(sql).toContain("estimator_user_id is distinct from $16");

    const row = normalizeBidBoardRow({
      Name: "Palm Villas",
      Status: "Estimate in Progress",
      "Project #": "DFW-4-11826-ab",
    });
    const ALEX = "636fd7e9-2575-4826-b11d-2869b24a12cf";
    expect(updateParams("deal-1", row, "2026-05-06T16:30:00.000Z", ALEX)[15]).toBe(ALEX);
    expect(updateParams("deal-2", row, "2026-05-06T16:30:00.000Z", null)[15]).toBeNull();
  });
});
