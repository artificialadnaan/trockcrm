import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import {
  buildRepWorkbook,
  workbookToBuffer,
  readWorkbookRows,
  DEAL_ID_HEADER,
  OFFICE_HEADER,
  EXPECTED_CLOSE_DATE_HEADER,
  STATUS_HEADER,
  CURRENT_CLOSE_DATE_HEADER,
  BID_BOARD_HEADER,
} from "../../../scripts/lib/close-date-xlsx.js";
import { parseExpectedCloseDate, type RepGroup } from "../../../scripts/lib/close-date-workflow.js";

/**
 * exceljs workbook build + round-trip. The matching-key columns (Deal ID +
 * Office) must be hidden AND locked; only the Expected Close Date column is
 * editable; and a filled date plus the locked key columns must survive a
 * serialize -> read round-trip so the re-import can match the row back.
 */
const ID1 = "00000000-0000-4000-8000-000000000001";
const ID2 = "00000000-0000-4000-8000-000000000002";

const group: RepGroup = {
  repName: "Alice",
  assignedRepId: "00000000-0000-4000-8000-0000000000a1",
  fileSlug: "alice",
  deals: [
    { tenantSchema: "office_dallas", dealId: ID1, dealNumber: "DFW-1", dealName: "Roof A", companyName: "Acme", stageName: "Estimating", estimatedValue: "125000", currentCloseDate: null, reason: "missing", isBidBoardOwned: false, assignedRepId: "a1", repName: "Alice" },
    { tenantSchema: "office_atlanta", dealId: ID2, dealNumber: "ATL-2", dealName: "Roof B", companyName: null, stageName: "Estimating", estimatedValue: null, currentCloseDate: "2026-01-15", reason: "past_due", isBidBoardOwned: true, assignedRepId: "a1", repName: "Alice" },
  ],
};

function headerColumns(ws: ExcelJS.Worksheet): { headerRow: number; cols: Record<string, number> } {
  let headerRow = -1;
  const cols: Record<string, number> = {};
  ws.eachRow((row, rowNumber) => {
    row.eachCell((cell, colNumber) => {
      if (cell.value === DEAL_ID_HEADER) headerRow = rowNumber;
    });
  });
  ws.getRow(headerRow).eachCell((cell, colNumber) => {
    if (typeof cell.value === "string") cols[cell.value] = colNumber;
  });
  return { headerRow, cols };
}

describe("buildRepWorkbook structure", () => {
  it("hides + locks the matching-key columns and leaves only the date column editable, under sheet protection", async () => {
    const wb = await buildRepWorkbook(group);
    const ws = wb.worksheets[0];
    const { headerRow, cols } = headerColumns(ws);

    // key columns hidden
    expect(ws.getColumn(cols[DEAL_ID_HEADER]).hidden).toBe(true);
    expect(ws.getColumn(cols[OFFICE_HEADER]).hidden).toBe(true);

    const firstDataRow = headerRow + 1;
    // key column cell locked; date column cell explicitly UNLOCKED
    expect(ws.getCell(firstDataRow, cols[DEAL_ID_HEADER]).protection?.locked).toBe(true);
    expect(ws.getCell(firstDataRow, cols[EXPECTED_CLOSE_DATE_HEADER]).protection?.locked).toBe(false);

    // sheet protection on
    expect((ws.sheetProtection as { sheet?: boolean } | undefined)?.sheet).toBe(true);
  });

  it("writes one data row per deal carrying the deal id + office in the hidden key columns", async () => {
    const wb = await buildRepWorkbook(group);
    const ws = wb.worksheets[0];
    const { headerRow, cols } = headerColumns(ws);
    expect(ws.getCell(headerRow + 1, cols[DEAL_ID_HEADER]).value).toBe(ID1);
    expect(ws.getCell(headerRow + 1, cols[OFFICE_HEADER]).value).toBe("office_dallas");
    expect(ws.getCell(headerRow + 2, cols[DEAL_ID_HEADER]).value).toBe(ID2);
    expect(ws.getCell(headerRow + 2, cols[OFFICE_HEADER]).value).toBe("office_atlanta");
  });

  it("renders the v2 context columns (Status / Current Close Date / Bid Board Owned)", async () => {
    const wb = await buildRepWorkbook(group);
    const ws = wb.worksheets[0];
    const { headerRow, cols } = headerColumns(ws);
    // missing deal
    expect(ws.getCell(headerRow + 1, cols[STATUS_HEADER]).value).toBe("Missing");
    expect(ws.getCell(headerRow + 1, cols[CURRENT_CLOSE_DATE_HEADER]).value ?? "").toBeFalsy();
    expect(ws.getCell(headerRow + 1, cols[BID_BOARD_HEADER]).value ?? "").toBeFalsy();
    // past-due, Bid Board Owned deal
    expect(ws.getCell(headerRow + 2, cols[STATUS_HEADER]).value).toBe("Past-due");
    expect(ws.getCell(headerRow + 2, cols[CURRENT_CLOSE_DATE_HEADER]).value).toBe("2026-01-15");
    expect(ws.getCell(headerRow + 2, cols[BID_BOARD_HEADER]).value).toBe("Yes");
  });
});

describe("workbook round-trip (serialize -> read)", () => {
  it("preserves the locked/hidden key columns and a rep-filled date through a write+read cycle", async () => {
    const wb = await buildRepWorkbook(group);
    const ws = wb.worksheets[0];
    const { headerRow, cols } = headerColumns(ws);

    // Simulate a rep filling the first deal's Expected Close Date.
    ws.getCell(headerRow + 1, cols[EXPECTED_CLOSE_DATE_HEADER]).value = new Date(Date.UTC(2026, 8, 15));

    const buffer = await workbookToBuffer(wb);
    const rows = await readWorkbookRows(buffer);

    expect(rows).toHaveLength(2);

    const filled = rows.find((r) => r.dealId === ID1)!;
    expect(filled.tenantSchema).toBe("office_dallas"); // key column survived
    expect(parseExpectedCloseDate(filled.rawDate)).toEqual({ status: "ok", value: "2026-09-15" });
    expect(filled.dealNumber).toBe("DFW-1");

    const unfilled = rows.find((r) => r.dealId === ID2)!;
    expect(unfilled.tenantSchema).toBe("office_atlanta");
    expect(parseExpectedCloseDate(unfilled.rawDate).status).toBe("blank");
  });
});
