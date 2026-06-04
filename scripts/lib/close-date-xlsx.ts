/**
 * Excel (.xlsx) IO for the close-date workflow, built on exceljs.
 *
 * The export produces one workbook per rep where the matching-key columns
 * (Deal ID + Office) are hidden AND locked, every context column is locked, and
 * ONLY the highlighted "Expected Close Date" column is editable — the sheet is
 * protected so a non-technical rep can fill dates without breaking the keys the
 * re-import relies on. `readWorkbookRows` parses a filled file back into rows.
 */
import ExcelJS from "exceljs";
import type { ImportRowInput, RepGroup } from "./close-date-workflow.js";

export const DEAL_ID_HEADER = "Deal ID";
export const OFFICE_HEADER = "Office";
export const DEAL_NUMBER_HEADER = "Deal #";
export const DEAL_NAME_HEADER = "Deal Name";
export const COMPANY_HEADER = "Company";
export const STAGE_HEADER = "Stage";
export const VALUE_HEADER = "Est. Value";
export const EXPECTED_CLOSE_DATE_HEADER = "Expected Close Date";

const WORKSHEET_NAME = "Expected Close Dates";

type ColumnDef = {
  header: string;
  width: number;
  hidden?: boolean;
  editable?: boolean;
  value: (deal: RepGroup["deals"][number]) => ExcelJS.CellValue;
};

const COLUMNS: ColumnDef[] = [
  { header: DEAL_ID_HEADER, width: 38, hidden: true, value: (d) => d.dealId },
  { header: OFFICE_HEADER, width: 16, hidden: true, value: (d) => d.tenantSchema },
  { header: DEAL_NUMBER_HEADER, width: 18, value: (d) => d.dealNumber },
  { header: DEAL_NAME_HEADER, width: 42, value: (d) => d.dealName },
  { header: COMPANY_HEADER, width: 28, value: (d) => d.companyName ?? "" },
  { header: STAGE_HEADER, width: 18, value: (d) => d.stageName ?? "" },
  { header: VALUE_HEADER, width: 16, value: (d) => (d.estimatedValue == null ? "" : Number(d.estimatedValue)) },
  { header: EXPECTED_CLOSE_DATE_HEADER, width: 22, editable: true, value: () => null },
];

const INSTRUCTION =
  'Fill in the highlighted "Expected Close Date" column for each deal, then save and email this file back. ' +
  "Use a real calendar date (e.g. 9/15/2026). Leave a row blank if you don't know yet. " +
  "Please don't edit, move, or delete the other columns — they're how each row is matched back to the deal.";

const HEADER_FILL_EDITABLE = "FFFFF2CC"; // soft amber for the date header
const CELL_FILL_EDITABLE = "FFFFFDE7"; // lighter amber for the date input cells

/** Build the per-rep workbook. */
export async function buildRepWorkbook(
  group: RepGroup,
  opts: { generatedOn?: string } = {},
): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "trockcrm close-date export";
  const ws = wb.addWorksheet(WORKSHEET_NAME, { views: [{ state: "frozen", ySplit: 2 }] });

  COLUMNS.forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    col.width = c.width;
    if (c.hidden) col.hidden = true;
  });

  // Row 1 — instruction banner spanning all columns.
  const lastCol = ws.getColumn(COLUMNS.length).letter;
  ws.mergeCells(`A1:${lastCol}1`);
  const banner = ws.getCell("A1");
  const subtitle = `  —  ${group.repName} · ${group.deals.length} deal(s)${opts.generatedOn ? ` · generated ${opts.generatedOn}` : ""}`;
  banner.value = INSTRUCTION + subtitle;
  banner.alignment = { wrapText: true, vertical: "middle" };
  banner.font = { bold: true, size: 11 };
  banner.protection = { locked: true };
  ws.getRow(1).height = 54;

  // Row 2 — headers.
  const headerRow = ws.getRow(2);
  COLUMNS.forEach((c, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = c.header;
    cell.font = { bold: true };
    cell.protection = { locked: true };
    cell.border = { bottom: { style: "thin" } };
    if (c.editable) {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_FILL_EDITABLE } };
    }
  });

  // Data rows.
  group.deals.forEach((deal, idx) => {
    const row = ws.getRow(3 + idx);
    COLUMNS.forEach((c, i) => {
      const cell = row.getCell(i + 1);
      cell.value = c.value(deal);
      cell.protection = { locked: !c.editable };
      if (c.editable) {
        cell.numFmt = "m/d/yyyy";
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: CELL_FILL_EDITABLE } };
        cell.dataValidation = {
          type: "date",
          operator: "between",
          allowBlank: true,
          showErrorMessage: true,
          formulae: [new Date(Date.UTC(2000, 0, 1)), new Date(Date.UTC(2100, 11, 31))],
          errorStyle: "warning",
          errorTitle: "Check the date",
          error: "Enter a real calendar date, e.g. 9/15/2026.",
          promptTitle: "Expected Close Date",
          prompt: "When do you expect this deal to close?",
        };
      }
    });
  });

  // Protect the sheet: only unlocked (date) cells are editable. No password — this
  // guards against accidental edits, not as a security control.
  await ws.protect("", {
    selectLockedCells: true,
    selectUnlockedCells: true,
    formatCells: false,
    formatColumns: false,
    formatRows: false,
    insertColumns: false,
    insertRows: false,
    deleteColumns: false,
    deleteRows: false,
    sort: false,
    autoFilter: false,
  });

  return wb;
}

/** Serialize a workbook to a Buffer. */
export async function workbookToBuffer(wb: ExcelJS.Workbook): Promise<Buffer> {
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf as ArrayBuffer);
}

function cellText(value: ExcelJS.CellValue): string {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    const obj = value as { text?: unknown; result?: unknown; richText?: Array<{ text?: string }> };
    if (Array.isArray(obj.richText)) return obj.richText.map((part) => part.text ?? "").join("").trim();
    if (obj.text != null) return String(obj.text).trim();
    if (obj.result != null) return String(obj.result).trim();
  }
  return "";
}

/** The raw date-cell value, normalised for {@link parseExpectedCloseDate}. */
function dateCellValue(value: ExcelJS.CellValue): unknown {
  if (value == null) return null;
  if (value instanceof Date || typeof value === "number" || typeof value === "string") return value;
  if (typeof value === "object") {
    const obj = value as { result?: unknown; text?: unknown };
    if (obj.result != null) return obj.result;
    if (obj.text != null) return obj.text;
  }
  return value;
}

/**
 * Parse a filled workbook (Buffer or file path) back into import rows. Locates
 * the header row by the "Deal ID" marker so a stray banner/blank row above it
 * doesn't matter. Fully blank rows are skipped.
 */
export async function readWorkbookRows(source: Buffer | string): Promise<ImportRowInput[]> {
  const wb = new ExcelJS.Workbook();
  if (typeof source === "string") await wb.xlsx.readFile(source);
  else await wb.xlsx.load(source);

  const ws = wb.worksheets[0];
  if (!ws) return [];

  let headerRowNum = -1;
  ws.eachRow((row, rowNumber) => {
    if (headerRowNum !== -1) return;
    row.eachCell((cell) => {
      if (cellText(cell.value) === DEAL_ID_HEADER) headerRowNum = rowNumber;
    });
  });
  if (headerRowNum === -1) {
    throw new Error('Could not find the header row (no "Deal ID" column). Use a file produced by the export script.');
  }

  const cols: Record<string, number> = {};
  ws.getRow(headerRowNum).eachCell((cell, colNumber) => {
    const text = cellText(cell.value);
    if (text) cols[text] = colNumber;
  });

  const idCol = cols[DEAL_ID_HEADER];
  const officeCol = cols[OFFICE_HEADER];
  const dateCol = cols[EXPECTED_CLOSE_DATE_HEADER];
  const numCol = cols[DEAL_NUMBER_HEADER];
  if (!idCol || !officeCol || !dateCol) {
    throw new Error(
      `Workbook is missing required columns (need "${DEAL_ID_HEADER}", "${OFFICE_HEADER}", "${EXPECTED_CLOSE_DATE_HEADER}"). Use a file produced by the export script.`,
    );
  }

  const rows: ImportRowInput[] = [];
  for (let r = headerRowNum + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const dealId = cellText(row.getCell(idCol).value);
    const tenantSchema = cellText(row.getCell(officeCol).value);
    const rawDate = dateCellValue(row.getCell(dateCol).value);
    const dealNumber = numCol ? cellText(row.getCell(numCol).value) : "";

    if (!dealId && !tenantSchema && (rawDate == null || rawDate === "")) continue; // blank row

    rows.push({
      tenantSchema,
      dealId,
      rawDate,
      rowNumber: r,
      dealNumber: dealNumber || undefined,
    });
  }
  return rows;
}
