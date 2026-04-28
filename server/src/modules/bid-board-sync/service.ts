import crypto from "crypto";
import { pool } from "../../db.js";
import { AppError } from "../../middleware/error-handler.js";

type RawBidBoardRow = Record<string, unknown>;

export interface BidBoardSyncPayload {
  office_slug?: string;
  officeSlug?: string;
  provenance?: {
    sourceFilename?: string;
    source_filename?: string;
    extractedAt?: string;
    extracted_at?: string;
    rowCount?: number;
    row_count?: number;
  };
  rows?: RawBidBoardRow[];
}

export interface NormalizedBidBoardRow {
  name: string;
  bidBoardEstimator: string | null;
  bidBoardOffice: string | null;
  bidBoardStatus: string | null;
  bidBoardSalesPricePerArea: string | null;
  bidBoardProjectCost: string | null;
  bidBoardProfitMarginPct: string | null;
  bidBoardTotalSales: string | null;
  bidBoardCreatedAt: string | null;
  bidBoardDueDate: string | null;
  bidBoardCustomerName: string | null;
  bidBoardCustomerContactRaw: string | null;
  bidBoardProjectNumber: string | null;
}

interface IngestionMetrics {
  rowsReceived: number;
  updated: number;
  noMatch: number;
  multiMatch: number;
  warnings: number;
  duplicateProjectNumbers: number;
  nullProjectNumbers: number;
  invalidDueDates: number;
}

const STRUCTURED_PROJECT_NUMBER_PATTERN = /^[A-Z]{3}-\d+-\d{5}-[a-z]{2}$/i;

function textValue(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

function numericText(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  const cleaned = String(value).replace(/[$,%\s,]/g, "").trim();
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? String(parsed) : null;
}

function parseExcelSerialDate(value: number): Date {
  const epoch = Date.UTC(1899, 11, 30);
  return new Date(epoch + value * 24 * 60 * 60 * 1000);
}

function toIsoTimestamp(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return null;
    const parsed = new Date(text);
    return Number.isNaN(parsed.getTime()) ? null : text;
  }
  const date =
    typeof value === "number"
      ? parseExcelSerialDate(value)
      : value instanceof Date
        ? value
        : new Date(String(value));
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

export function parseBidBoardDueDate(
  value: unknown,
  projectName = "unknown project"
): { value: string | null; warning: string | null } {
  if (value == null || value === "") return { value: null, warning: null };
  const date =
    typeof value === "number"
      ? parseExcelSerialDate(value)
      : value instanceof Date
        ? value
        : new Date(String(value));

  if (Number.isNaN(date.getTime())) {
    return {
      value: null,
      warning: `Due Date for ${projectName} could not be parsed and was stored as NULL`,
    };
  }

  const year = date.getUTCFullYear();
  if (year < 2020 || year > 2050) {
    return {
      value: null,
      warning: `Due Date for ${projectName} is outside accepted range (${year}) and was stored as NULL`,
    };
  }

  return { value: date.toISOString().slice(0, 10), warning: null };
}

export function normalizeBidBoardRow(row: RawBidBoardRow): NormalizedBidBoardRow {
  const name = textValue(row.Name) ?? "";
  const dueDate = parseBidBoardDueDate(row["Due Date"], name);

  return {
    name,
    bidBoardEstimator: textValue(row.Estimator),
    bidBoardOffice: textValue(row.Office),
    bidBoardStatus: textValue(row.Status),
    bidBoardSalesPricePerArea: textValue(row["Sales Price Per Area"]),
    bidBoardProjectCost: numericText(row["Project Cost"]),
    bidBoardProfitMarginPct: numericText(row["Profit Margin"]),
    bidBoardTotalSales: numericText(row["Total Sales"]),
    bidBoardCreatedAt: toIsoTimestamp(row["Created Date"]),
    bidBoardDueDate: dueDate.value,
    bidBoardCustomerName: textValue(row["Customer Name"]),
    bidBoardCustomerContactRaw: textValue(row["Customer Contact"]),
    bidBoardProjectNumber: textValue(row["Project #"]),
  };
}

function validateSchemaName(name: string): string {
  if (!/^office_[a-z][a-z0-9_]*$/.test(name)) {
    throw new AppError(400, "Invalid office slug");
  }
  return name;
}

function normalizeOfficeSlug(payload: BidBoardSyncPayload): string {
  return textValue(payload.office_slug) ?? textValue(payload.officeSlug) ?? "dallas";
}

function hashRows(rows: RawBidBoardRow[]): string {
  return crypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

export function buildBidBoardDealUpdateSql(schemaName: string): string {
  const schema = validateSchemaName(schemaName);
  return `
    UPDATE ${schema}.deals
       SET name = $2,
           bid_board_estimator = $3,
           bid_board_office = $4,
           bid_board_status = $5,
           bid_board_sales_price_per_area = $6,
           bid_board_project_cost = $7,
           bid_board_profit_margin_pct = $8,
           bid_board_total_sales = $9,
           bid_board_created_at = $10,
           bid_board_due_date = $11,
           bid_board_customer_name = $12,
           bid_board_customer_contact_raw = $13,
           bid_board_project_number = $14,
           updated_at = NOW()
     WHERE id = $1
       AND (
            name IS DISTINCT FROM $2 OR
            bid_board_estimator IS DISTINCT FROM $3 OR
            bid_board_office IS DISTINCT FROM $4 OR
            bid_board_status IS DISTINCT FROM $5 OR
            bid_board_sales_price_per_area IS DISTINCT FROM $6 OR
            bid_board_project_cost IS DISTINCT FROM $7 OR
            bid_board_profit_margin_pct IS DISTINCT FROM $8 OR
            bid_board_total_sales IS DISTINCT FROM $9 OR
            bid_board_created_at IS DISTINCT FROM $10 OR
            bid_board_due_date IS DISTINCT FROM $11 OR
            bid_board_customer_name IS DISTINCT FROM $12 OR
            bid_board_customer_contact_raw IS DISTINCT FROM $13 OR
            bid_board_project_number IS DISTINCT FROM $14
       )
  `;
}

function updateParams(dealId: string, row: NormalizedBidBoardRow) {
  return [
    dealId,
    row.name,
    row.bidBoardEstimator,
    row.bidBoardOffice,
    row.bidBoardStatus,
    row.bidBoardSalesPricePerArea,
    row.bidBoardProjectCost,
    row.bidBoardProfitMarginPct,
    row.bidBoardTotalSales,
    row.bidBoardCreatedAt,
    row.bidBoardDueDate,
    row.bidBoardCustomerName,
    row.bidBoardCustomerContactRaw,
    row.bidBoardProjectNumber,
  ];
}

async function findDealIds(client: { query: Function }, schemaName: string, row: NormalizedBidBoardRow) {
  if (row.bidBoardProjectNumber) {
    const byProject = await client.query(
      `SELECT id FROM ${schemaName}.deals WHERE bid_board_project_number = $1`,
      [row.bidBoardProjectNumber]
    );
    if (byProject.rows.length > 0) return byProject.rows.map((r: { id: string }) => r.id);
  }

  if (row.bidBoardCreatedAt) {
    const byComposite = await client.query(
      `SELECT id FROM ${schemaName}.deals
        WHERE bid_board_project_number IS NULL
          AND LOWER(TRIM(name)) = LOWER(TRIM($1))
          AND bid_board_created_at = $2::timestamptz`,
      [row.name, row.bidBoardCreatedAt]
    );
    return byComposite.rows.map((r: { id: string }) => r.id);
  }

  return [];
}

export async function ingestBidBoardRows(payload: BidBoardSyncPayload) {
  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  const officeSlug = normalizeOfficeSlug(payload);
  const schemaName = validateSchemaName(`office_${officeSlug}`);
  const sourceFilename =
    textValue(payload.provenance?.sourceFilename) ?? textValue(payload.provenance?.source_filename);
  const extractedAt =
    textValue(payload.provenance?.extractedAt) ?? textValue(payload.provenance?.extracted_at);
  const payloadHash = hashRows(rows);
  const warnings: string[] = [];
  const errors: string[] = [];
  const metrics: IngestionMetrics = {
    rowsReceived: rows.length,
    updated: 0,
    noMatch: 0,
    multiMatch: 0,
    warnings: 0,
    duplicateProjectNumbers: 0,
    nullProjectNumbers: 0,
    invalidDueDates: 0,
  };

  const seenProjectNumbers = new Set<string>();
  const duplicateProjectNumbers = new Set<string>();
  for (const row of rows) {
    const projectNumber = textValue(row["Project #"]);
    if (!projectNumber) {
      metrics.nullProjectNumbers++;
      continue;
    }
    if (seenProjectNumbers.has(projectNumber)) duplicateProjectNumbers.add(projectNumber);
    seenProjectNumbers.add(projectNumber);
  }
  metrics.duplicateProjectNumbers = duplicateProjectNumbers.size;
  for (const projectNumber of duplicateProjectNumbers) {
    warnings.push(`Incoming payload contains duplicate Project #: ${projectNumber}`);
  }

  const client = await pool.connect();
  let runId: string | null = null;
  try {
    await client.query("BEGIN");

    const runResult = await client.query(
      `INSERT INTO ${schemaName}.bid_board_sync_runs
       (source_filename, extracted_at, payload_hash, row_count, status)
       VALUES ($1, $2::timestamptz, $3, $4, 'processing')
       RETURNING id`,
      [sourceFilename, extractedAt, payloadHash, rows.length]
    );
    runId = runResult.rows[0]?.id ?? null;

    const updateSql = buildBidBoardDealUpdateSql(schemaName);
    for (const rawRow of rows) {
      const normalized = normalizeBidBoardRow(rawRow);
      if (!normalized.name) {
        metrics.noMatch++;
        warnings.push("Skipped Bid Board row without Name");
        continue;
      }

      const dueDate = parseBidBoardDueDate(rawRow["Due Date"], normalized.name);
      if (dueDate.warning) {
        metrics.invalidDueDates++;
        warnings.push(dueDate.warning);
      }
      if (!normalized.bidBoardProjectNumber) {
        warnings.push(`Bid Board row "${normalized.name}" has NULL Project #`);
      }

      const matches = await findDealIds(client, schemaName, normalized);
      if (matches.length === 0) {
        metrics.noMatch++;
        if (
          normalized.bidBoardProjectNumber &&
          STRUCTURED_PROJECT_NUMBER_PATTERN.test(normalized.bidBoardProjectNumber)
        ) {
          warnings.push(
            `No CRM deal matched structured Bid Board Project # ${normalized.bidBoardProjectNumber} (${normalized.name})`
          );
        }
        continue;
      }
      if (matches.length > 1) {
        metrics.multiMatch++;
        warnings.push(
          `Multiple CRM deals matched Bid Board row ${normalized.bidBoardProjectNumber ?? normalized.name}; skipped update`
        );
        continue;
      }

      const updateResult = await client.query(updateSql, updateParams(matches[0], normalized));
      if ((updateResult.rowCount ?? 0) > 0) metrics.updated++;
    }

    metrics.warnings = warnings.length;
    await client.query(
      `UPDATE ${schemaName}.bid_board_sync_runs
          SET updated_count = $2,
              no_match_count = $3,
              multi_match_count = $4,
              warning_count = $5,
              status = $6,
              errors = $7::jsonb,
              warnings = $8::jsonb
        WHERE id = $1`,
      [
        runId,
        metrics.updated,
        metrics.noMatch,
        metrics.multiMatch,
        warnings.length,
        errors.length > 0 ? "failed" : "success",
        JSON.stringify(errors),
        JSON.stringify(warnings),
      ]
    );
    await client.query("COMMIT");

    for (const warning of warnings) {
      console.warn(`[BidBoardSync] ${warning}`);
    }

    return { runId, metrics, warnings };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
