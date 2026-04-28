import { describe, expect, it } from "vitest";

const {
  buildBidBoardDealUpdateSql,
  normalizeBidBoardRow,
  parseBidBoardDueDate,
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

  it("normalizes the 13 Bid Board fields without touching CRM-managed fields", () => {
    const normalized = normalizeBidBoardRow({
      Name: "Palm Villas",
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

  it("builds guarded update SQL that only touches the 13 Bid Board fields", () => {
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
});
