export type ExcelColumn = {
  key: string;
  header: string;
  type?: "text" | "number" | "currency" | "date" | "percent" | "boolean";
};

export type ExcelSheet = {
  name: string;
  columns: ExcelColumn[];
  rows: Array<Record<string, unknown>>;
};

export type ExcelWorkbookInput = {
  sheets: ExcelSheet[];
};

type WorkbookSheet = ExcelSheet & { safeName: string };

type ZipEntry = {
  path: string;
  data: Uint8Array;
};

const CURRENCY_FORMAT = "$#,##0.00;[Red]-$#,##0.00";
const INTEGER_FORMAT = "#,##0";
const NUMBER_FORMAT = "#,##0.00";
const PERCENT_FORMAT = "0.0%";
const DATE_FORMAT = "m/d/yyyy";
const encoder = new TextEncoder();

function safeSheetName(name: string, fallback: string) {
  const cleaned = name.replace(/[:\\/?*\\[\\]]/g, " ").trim().slice(0, 31);
  return cleaned || fallback;
}

function escapeXml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function columnName(index: number) {
  let value = index + 1;
  let name = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

export function excelDateSerial(value: Date) {
  const utc = Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
  return Math.round((utc - Date.UTC(1899, 11, 30)) / 86_400_000);
}

function normalizeCellValue(value: unknown, type: ExcelColumn["type"]) {
  if (value === null || value === undefined) return { value: "", kind: "text" as const };
  if (type === "date") {
    const date = value instanceof Date ? value : new Date(String(value));
    if (Number.isNaN(date.getTime())) return { value: String(value), kind: "text" as const };
    return { value: excelDateSerial(date), kind: "number" as const, style: 2 };
  }
  if (type === "currency" || type === "number" || type === "percent") {
    const numeric = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(numeric)) return { value: "", kind: "text" as const };
    if (type === "currency") return { value: numeric, kind: "number" as const, style: 1 };
    if (type === "percent") {
      const normalized = Math.abs(numeric) > 1 && Math.abs(numeric) <= 100 ? numeric / 100 : numeric;
      return { value: normalized, kind: "number" as const, style: 3 };
    }
    return { value: numeric, kind: "number" as const, style: Number.isInteger(numeric) ? 4 : 5 };
  }
  if (type === "boolean") return { value: Boolean(value) ? 1 : 0, kind: "boolean" as const };
  return { value: String(value), kind: "text" as const };
}

function cellXml(value: unknown, rowIndex: number, columnIndex: number, type: ExcelColumn["type"]) {
  const ref = `${columnName(columnIndex)}${rowIndex + 1}`;
  const normalized = normalizeCellValue(value, type);
  if (normalized.kind === "number") {
    const style = normalized.style ? ` s="${normalized.style}"` : "";
    return `<c r="${ref}"${style}><v>${normalized.value}</v></c>`;
  }
  if (normalized.kind === "boolean") {
    return `<c r="${ref}" t="b"><v>${normalized.value}</v></c>`;
  }
  return `<c r="${ref}" t="inlineStr"><is><t>${escapeXml(normalized.value)}</t></is></c>`;
}

function worksheetXml(sheet: WorkbookSheet) {
  const rows = [
    sheet.columns.map((column) => ({ value: column.header, type: "text" as const })),
    ...sheet.rows.map((row) =>
      sheet.columns.map((column) => ({ value: row[column.key], type: column.type }))
    ),
  ];
  const rowXml = rows
    .map((row, rowIndex) => {
      const cells = row
        .map((cell, columnIndex) => cellXml(cell.value, rowIndex, columnIndex, cell.type))
        .join("");
      return `<row r="${rowIndex + 1}">${cells}</row>`;
    })
    .join("");
  const columnXml = sheet.columns
    .map((column, index) => {
      const width = Math.max(column.header.length + 2, 14);
      return `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`;
    })
    .join("");

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <cols>${columnXml}</cols>
  <sheetData>${rowXml}</sheetData>
</worksheet>`;
}

function workbookXml(sheets: WorkbookSheet[]) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>${sheets.map((sheet, index) => `<sheet name="${escapeXml(sheet.safeName)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("")}</sheets>
</workbook>`;
}

function workbookRelsXml(sheets: WorkbookSheet[]) {
  const sheetRels = sheets
    .map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${sheetRels}
  <Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;
}

function contentTypesXml(sheets: WorkbookSheet[]) {
  const sheetOverrides = sheets
    .map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  ${sheetOverrides}
</Types>`;
}

function rootRelsXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;
}

function stylesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="5">
    <numFmt numFmtId="164" formatCode="${escapeXml(CURRENCY_FORMAT)}"/>
    <numFmt numFmtId="165" formatCode="${DATE_FORMAT}"/>
    <numFmt numFmtId="166" formatCode="${PERCENT_FORMAT}"/>
    <numFmt numFmtId="167" formatCode="${INTEGER_FORMAT}"/>
    <numFmt numFmtId="168" formatCode="${NUMBER_FORMAT}"/>
  </numFmts>
  <fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>
  <fills count="1"><fill><patternFill patternType="none"/></fill></fills>
  <borders count="1"><border/></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="6">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
    <xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
    <xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
    <xf numFmtId="167" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
    <xf numFmtId="168" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
}

function makeCrcTable() {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let j = 0; j < 8; j += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
}

const crcTable = makeCrcTable();

function crc32(data: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writeUint16(output: number[], value: number) {
  output.push(value & 0xff, (value >>> 8) & 0xff);
}

function writeUint32(output: number[], value: number) {
  output.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}

function concatBytes(chunks: Uint8Array[]) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function createZip(entries: ZipEntry[]) {
  const localChunks: Uint8Array[] = [];
  const centralChunks: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.path);
    const crc = crc32(entry.data);
    const local: number[] = [];
    writeUint32(local, 0x04034b50);
    writeUint16(local, 20);
    writeUint16(local, 0);
    writeUint16(local, 0);
    writeUint16(local, 0);
    writeUint16(local, 0);
    writeUint32(local, crc);
    writeUint32(local, entry.data.length);
    writeUint32(local, entry.data.length);
    writeUint16(local, nameBytes.length);
    writeUint16(local, 0);
    const localHeader = new Uint8Array(local);
    localChunks.push(localHeader, nameBytes, entry.data);

    const central: number[] = [];
    writeUint32(central, 0x02014b50);
    writeUint16(central, 20);
    writeUint16(central, 20);
    writeUint16(central, 0);
    writeUint16(central, 0);
    writeUint16(central, 0);
    writeUint16(central, 0);
    writeUint32(central, crc);
    writeUint32(central, entry.data.length);
    writeUint32(central, entry.data.length);
    writeUint16(central, nameBytes.length);
    writeUint16(central, 0);
    writeUint16(central, 0);
    writeUint16(central, 0);
    writeUint16(central, 0);
    writeUint32(central, 0);
    writeUint32(central, offset);
    centralChunks.push(new Uint8Array(central), nameBytes);

    offset += localHeader.length + nameBytes.length + entry.data.length;
  }

  const centralDirectory = concatBytes(centralChunks);
  const end: number[] = [];
  writeUint32(end, 0x06054b50);
  writeUint16(end, 0);
  writeUint16(end, 0);
  writeUint16(end, entries.length);
  writeUint16(end, entries.length);
  writeUint32(end, centralDirectory.length);
  writeUint32(end, offset);
  writeUint16(end, 0);

  return concatBytes([...localChunks, centralDirectory, new Uint8Array(end)]);
}

export function buildExcelWorkbook(input: ExcelWorkbookInput) {
  return {
    sheets: input.sheets.map((sheet, index) => ({
      ...sheet,
      safeName: safeSheetName(sheet.name, `Sheet ${index + 1}`),
    })),
  };
}

export function createXlsxBlob(input: ExcelWorkbookInput) {
  const workbook = buildExcelWorkbook(input);
  const entries: ZipEntry[] = [
    { path: "[Content_Types].xml", data: encoder.encode(contentTypesXml(workbook.sheets)) },
    { path: "_rels/.rels", data: encoder.encode(rootRelsXml()) },
    { path: "xl/workbook.xml", data: encoder.encode(workbookXml(workbook.sheets)) },
    { path: "xl/_rels/workbook.xml.rels", data: encoder.encode(workbookRelsXml(workbook.sheets)) },
    { path: "xl/styles.xml", data: encoder.encode(stylesXml()) },
    ...workbook.sheets.map((sheet, index) => ({
      path: `xl/worksheets/sheet${index + 1}.xml`,
      data: encoder.encode(worksheetXml(sheet)),
    })),
  ];

  return new Blob([createZip(entries)], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

export function exportToExcel(input: ExcelWorkbookInput & { filename: string }) {
  const blob = createXlsxBlob(input);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = input.filename.endsWith(".xlsx") ? input.filename : `${input.filename}.xlsx`;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

function labelFromKey(key: string) {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function inferColumnType(key: string, value: unknown): ExcelColumn["type"] {
  const lower = key.toLowerCase();
  if (lower.includes("date") || lower.endsWith("at")) return "date";
  if (
    lower.includes("value") ||
    lower.includes("revenue") ||
    lower.includes("commission") ||
    lower.includes("pipeline") ||
    lower.includes("margin") ||
    lower.includes("floor") ||
    lower.includes("amount")
  ) return "currency";
  if (lower.includes("rate") || lower.includes("percent") || lower.includes("share")) return "percent";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return "text";
}

function flattenObject(input: Record<string, unknown>, prefix = ""): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const nextKey = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date)) {
      Object.assign(output, flattenObject(value as Record<string, unknown>, nextKey));
    } else {
      output[nextKey] = value;
    }
  }
  return output;
}

export function sheetsFromReport(reportName: string, report: object | null | undefined): ExcelSheet[] {
  if (!report) return [];
  const sheets: ExcelSheet[] = [];
  const scalarSummary: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(report as Record<string, unknown>)) {
    if (Array.isArray(value)) {
      const rows = value
        .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object" && !Array.isArray(row))
        .map((row) => flattenObject(row));
      if (rows.length === 0) continue;
      const keys = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
      sheets.push({
        name: labelFromKey(key),
        columns: keys.map((columnKey) => ({
          key: columnKey,
          header: labelFromKey(columnKey),
          type: inferColumnType(columnKey, rows.find((row) => row[columnKey] !== undefined)?.[columnKey]),
        })),
        rows,
      });
    } else if (value && typeof value === "object") {
      const flattened = flattenObject(value as Record<string, unknown>, key);
      Object.assign(scalarSummary, flattened);
    } else {
      scalarSummary[key] = value;
    }
  }

  if (Object.keys(scalarSummary).length > 0) {
    const row = scalarSummary;
    sheets.unshift({
      name: `${reportName} Summary`,
      columns: Object.keys(row).map((key) => ({
        key,
        header: labelFromKey(key),
        type: inferColumnType(key, row[key]),
      })),
      rows: [row],
    });
  }

  return sheets;
}
