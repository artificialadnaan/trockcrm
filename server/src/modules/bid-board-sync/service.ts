import crypto from "crypto";
import {
  getHoldStateAtStageEntry,
  isTerminalWorkflowStage,
  type WorkflowRoute,
} from "@trock-crm/shared/types";
import { bidBoardStatusToCrmStage, normalizeBidBoardStatus } from "@trock-crm/shared/lib/bidBoardStatusMap";
import { pool } from "../../db.js";
import { AppError } from "../../middleware/error-handler.js";
import { buildAuditActorFromSystem } from "../audit/audit-logger.js";
import { logActivityWithPgClient } from "../audit/pg-activity-logger.js";
import { BID_BOARD_SYNC } from "../audit/system-processes.js";

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
  sheets?: Record<string, RawBidBoardRow[]> | Array<{ name?: string; rows?: RawBidBoardRow[] }>;
}

export interface NormalizedBidBoardRow {
  name: string;
  bidBoardProjectId: string | null;
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
  matched: number;
  stageUpdated: number;
  noMatch: number;
  multiMatch: number;
  warnings: number;
  duplicateProjectNumbers: number;
  nullProjectNumbers: number;
  invalidDueDates: number;
  skippedNoProjectNumber: number;
  skippedUnmappedStatus: number;
  skippedTemplate: number;
  appliedBackward: number;
  skippedTerminal: number;
  skippedNoStageChange: number;
  estimateUpdated: number;
  estimateUpdatedHigher: number;
  estimateUpdatedLower: number;
  estimateSkippedNoValue: number;
  estimateSkippedNoChange: number;
  estimateSkippedTerminal: number;
  estimateWarnings: number;
}

interface DealMatch {
  id: string;
  name: string | null;
  stage_id: string;
  stage_slug: string;
  stage_display_order: number | null;
  stage_is_terminal: boolean | null;
  stage_entered_at: string | null;
  on_hold: boolean | null;
  on_hold_started_at: string | null;
  on_hold_accumulated_seconds: number | null;
  on_hold_accumulated_seconds_at_stage_entry: number | null;
  workflow_route: WorkflowRoute | null;
  deal_number: string | null;
  project_number: string | null;
  bid_board_project_number: string | null;
  bid_board_estimator: string | null;
  bid_board_office: string | null;
  bid_board_status: string | null;
  bid_board_sales_price_per_area: string | null;
  bid_board_project_cost: string | null;
  bid_board_profit_margin_pct: string | null;
  bid_board_total_sales: string | null;
  bid_board_created_at: string | null;
  bid_board_due_date: string | null;
  bid_board_customer_name: string | null;
  bid_board_customer_contact_raw: string | null;
  bid_board_stage_slug: string | null;
  bid_board_stage_family: string | null;
  bid_board_stage_status: string | null;
  bid_board_last_updated_at: string | null;
  bid_estimate: string | null;
}

type BidBoardAuditDeal = Pick<DealMatch, "id" | "name" | "deal_number" | "project_number">;

async function logBidBoardActivity(
  client: { query: Function },
  schemaName: string,
  deal: BidBoardAuditDeal,
  fieldChanges: Record<string, { from: unknown; to: unknown }>,
  metadata: Record<string, unknown> = {}
) {
  if (Object.keys(fieldChanges).length === 0) return;
  await logActivityWithPgClient({
    client: client as never,
    schemaName,
    actor: buildAuditActorFromSystem({ systemProcess: BID_BOARD_SYNC }),
    action: "update",
    entity: {
      tableName: "deals",
      entityType: "deal",
      recordId: deal.id,
      nameSnapshot: deal.name ?? "Deal",
      secondaryIdSnapshot: deal.project_number ?? deal.deal_number ?? null,
    },
    fieldChanges,
    metadata,
  });
}

interface StageConfig {
  id: string;
  slug: string;
  display_order: number | null;
  is_terminal: boolean | null;
}

const STRUCTURED_PROJECT_NUMBER_PATTERN = /^[A-Z]{3}-\d+-\d{5}-[a-z]{2}$/i;
const MAX_UNMATCHED_PROJECT_NUMBERS = 100;
const BID_BOARD_ESTIMATE_SYNC_SOURCE = "bid_board_sync";
const BID_BOARD_ESTIMATE_SYNC_REASON = "Bid Board export sync - Total Sales -> Bid Estimate";

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

function moneyCents(value: string | number | null | undefined): number | null {
  if (value == null || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(String(value).replace(/[$,\s]/g, ""));
  if (!Number.isFinite(parsed)) return null;
  return Math.round(parsed * 100);
}

function centsToMoneyText(value: number): string {
  return (value / 100).toFixed(2);
}

function integerIdText(value: unknown): string | null {
  const text = textValue(value);
  return text && /^\d+$/.test(text) ? text : null;
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

export function normalizeBidBoardProjectNumber(value: unknown): string | null {
  const text = textValue(value);
  return text ? text.toLowerCase() : null;
}

function extractRows(payload: BidBoardSyncPayload): RawBidBoardRow[] {
  if (Array.isArray(payload.rows)) return payload.rows;
  if (!payload.sheets) return [];
  if (Array.isArray(payload.sheets)) {
    return payload.sheets.flatMap((sheet) => (Array.isArray(sheet.rows) ? sheet.rows : []));
  }
  return Object.values(payload.sheets).flatMap((rows) => (Array.isArray(rows) ? rows : []));
}

export function normalizeBidBoardRow(row: RawBidBoardRow): NormalizedBidBoardRow {
  const name = textValue(row.Name) ?? "";
  const dueDate = parseBidBoardDueDate(row["Due Date"], name);

  return {
    name,
    bidBoardProjectId:
      integerIdText(row["BidBoard Project ID"]) ??
      integerIdText(row["Bid Board Project ID"]) ??
      integerIdText(row["Project ID"]) ??
      integerIdText(row["Procore Project ID"]) ??
      integerIdText(row.bidboardProjectId) ??
      integerIdText(row.bidBoardProjectId),
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
           -- Bid Board exports do not include a per-row updated-at, so this stores the sync cycle timestamp.
           bid_board_last_updated_at = $15::timestamptz,
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
            bid_board_project_number IS DISTINCT FROM $14 OR
            bid_board_last_updated_at IS DISTINCT FROM $15::timestamptz
       )
     RETURNING id, name, deal_number, project_number
  `;
}

export function updateParams(dealId: string, row: NormalizedBidBoardRow, bidBoardLastUpdatedAt: string) {
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
    bidBoardLastUpdatedAt,
  ];
}

function dealMatchSelectSql(schemaName: string): string {
  return `
    SELECT d.id,
           d.name,
           d.stage_id,
           d.stage_entered_at,
           d.on_hold,
           d.on_hold_started_at,
           d.on_hold_accumulated_seconds,
           d.on_hold_accumulated_seconds_at_stage_entry,
           d.workflow_route,
           d.deal_number,
           d.project_number,
           d.bid_board_project_number,
           d.bid_board_estimator,
           d.bid_board_office,
           d.bid_board_status,
           d.bid_board_sales_price_per_area,
           d.bid_board_project_cost,
           d.bid_board_profit_margin_pct,
           d.bid_board_total_sales,
           d.bid_board_created_at,
           d.bid_board_due_date,
           d.bid_board_customer_name,
           d.bid_board_customer_contact_raw,
           d.bid_board_stage_slug,
           d.bid_board_stage_family,
           d.bid_board_stage_status,
           d.bid_board_last_updated_at,
           d.bid_estimate,
           psc.slug AS stage_slug,
           psc.display_order AS stage_display_order,
           psc.is_terminal AS stage_is_terminal
      FROM ${schemaName}.deals d
      LEFT JOIN public.pipeline_stage_config psc ON psc.id = d.stage_id
     WHERE d.is_active = true`;
}

async function findDealMatches(
  client: { query: Function },
  schemaName: string,
  row: NormalizedBidBoardRow
): Promise<DealMatch[]> {
  if (row.bidBoardProjectId) {
    const byBidBoardId = await client.query(
      `${dealMatchSelectSql(schemaName)}
       AND d.procore_bid_id = $1::bigint`,
      [row.bidBoardProjectId]
    );
    if (byBidBoardId.rows.length > 0) return byBidBoardId.rows;
  }

  const projectNumber = normalizeBidBoardProjectNumber(row.bidBoardProjectNumber);
  if (projectNumber) {
    const byProject = await client.query(
      `${dealMatchSelectSql(schemaName)}
       AND (
            LOWER(TRIM(d.project_number)) = $1 OR
            LOWER(TRIM(d.deal_number)) = $1 OR
            LOWER(TRIM(d.bid_board_project_number)) = $1
       )`,
      [projectNumber]
    );
    if (byProject.rows.length > 0) return byProject.rows;
  }

  if (row.bidBoardCreatedAt) {
    const byComposite = await client.query(
      `${dealMatchSelectSql(schemaName)}
        AND d.bid_board_project_number IS NULL
        AND LOWER(TRIM(d.name)) = LOWER(TRIM($1))
        AND d.bid_board_created_at = $2::timestamptz`,
      [row.name, row.bidBoardCreatedAt]
    );
    return byComposite.rows;
  }

  return [];
}

export async function findDealIds(client: { query: Function }, schemaName: string, row: NormalizedBidBoardRow) {
  const matches = await findDealMatches(client, validateSchemaName(schemaName), row);
  return matches.map((r) => r.id);
}

async function findTargetStage(client: { query: Function }, stageSlug: string): Promise<StageConfig | null> {
  const result = await client.query(
    `SELECT id, slug, display_order, is_terminal
       FROM public.pipeline_stage_config
      WHERE slug = $1
        AND is_active_pipeline = true
      ORDER BY display_order ASC
      LIMIT 1`,
    [stageSlug]
  );
  return result.rows[0] ?? null;
}

async function findSystemChangedByUserId(client: { query: Function }, officeSlug: string): Promise<string | null> {
  const result = await client.query(
    `SELECT u.id
       FROM public.users u
       LEFT JOIN public.offices o ON o.id = u.office_id
      WHERE u.is_active = true
        AND u.role IN ('admin', 'director')
      ORDER BY CASE WHEN o.slug = $1 THEN 0 ELSE 1 END, u.created_at ASC
      LIMIT 1`,
    [officeSlug]
  );
  return result.rows[0]?.id ?? null;
}

function workflowRoute(value: string | null): WorkflowRoute {
  return value === "service" ? "service" : "normal";
}

function stageOrder(value: number | string | null | undefined): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function stageFamilyForSlug(slug: string): string {
  switch (slug) {
    case "estimating":
    case "service_estimating":
    case "estimate_under_review":
      return "estimating";
    case "estimate_sent_to_client":
      return "proposal";
    case "contract":
      return "contract";
    case "won":
      return "terminal_won";
    case "lost":
      return "terminal_loss";
    default:
      return "downstream";
  }
}

function targetStageSlugForDeal(stageSlug: string, route: WorkflowRoute, row: NormalizedBidBoardRow): string {
  const status = normalizeBidBoardStatus(row.bidBoardStatus);
  return stageSlug === "estimating" && (route === "service" || status === "service estimating") ? "service_estimating" : stageSlug;
}

function buildBidBoardMirrorFieldChanges(deal: DealMatch, row: NormalizedBidBoardRow, bidBoardLastUpdatedAt: string) {
  return {
    name: { from: deal.name, to: row.name },
    bidBoardEstimator: { from: deal.bid_board_estimator, to: row.bidBoardEstimator },
    bidBoardOffice: { from: deal.bid_board_office, to: row.bidBoardOffice },
    bidBoardStatus: { from: deal.bid_board_status, to: row.bidBoardStatus },
    bidBoardSalesPricePerArea: { from: deal.bid_board_sales_price_per_area, to: row.bidBoardSalesPricePerArea },
    bidBoardProjectCost: { from: deal.bid_board_project_cost, to: row.bidBoardProjectCost },
    bidBoardProfitMarginPct: { from: deal.bid_board_profit_margin_pct, to: row.bidBoardProfitMarginPct },
    bidBoardTotalSales: { from: deal.bid_board_total_sales, to: row.bidBoardTotalSales },
    bidBoardCreatedAt: { from: deal.bid_board_created_at, to: row.bidBoardCreatedAt },
    bidBoardDueDate: { from: deal.bid_board_due_date, to: row.bidBoardDueDate },
    bidBoardCustomerName: { from: deal.bid_board_customer_name, to: row.bidBoardCustomerName },
    bidBoardCustomerContactRaw: { from: deal.bid_board_customer_contact_raw, to: row.bidBoardCustomerContactRaw },
    bidBoardProjectNumber: { from: deal.bid_board_project_number, to: row.bidBoardProjectNumber },
    bidBoardLastUpdatedAt: { from: deal.bid_board_last_updated_at, to: bidBoardLastUpdatedAt },
  };
}

async function updateBidBoardStageMetadata(
  client: { query: Function },
  schemaName: string,
  deal: DealMatch,
  expectedStageId: string,
  targetStageSlug: string,
  row: NormalizedBidBoardRow
): Promise<boolean> {
  const status = row.bidBoardStatus ?? targetStageSlug;
  const result = await client.query(
    `UPDATE ${schemaName}.deals
        SET is_bid_board_owned = true,
            bid_board_stage_slug = $2::text,
            bid_board_stage_family = $3::text,
            bid_board_stage_status = $4::text,
            bid_board_stage_entered_at = COALESCE(bid_board_stage_entered_at, NOW()),
            read_only_synced_at = NOW(),
            updated_at = NOW()
      WHERE id = $1
        AND stage_id = $5`,
    [deal.id, targetStageSlug, stageFamilyForSlug(targetStageSlug), status, expectedStageId]
  );
  const updated = (result.rowCount ?? 0) > 0;
  if (updated) {
    await logBidBoardActivity(client, schemaName, { ...deal, name: deal.name ?? row.name }, {
      bidBoardStageSlug: { from: deal.bid_board_stage_slug, to: targetStageSlug },
      bidBoardStageFamily: { from: deal.bid_board_stage_family, to: stageFamilyForSlug(targetStageSlug) },
      bidBoardStageStatus: { from: deal.bid_board_stage_status, to: status },
      readOnlySyncedAt: { from: null, to: "now" },
    }, { source: "stage_metadata_refresh" });
  }
  return updated;
}

function isTemplatesStatus(value: string | null): boolean {
  return normalizeBidBoardStatus(value) === "templates";
}

interface StageWritebackResult {
  updated: boolean;
  skippedNoStageChange: boolean;
  appliedBackward: boolean;
  skippedTerminal: boolean;
  warning: string | null;
}

interface EstimateWritebackResult {
  updated: boolean;
  skippedNoValue: boolean;
  skippedNoChange: boolean;
  skippedTerminal: boolean;
  higher: boolean;
  lower: boolean;
  warning: string | null;
}

async function writeEstimateIfNeeded(
  client: { query: Function },
  schemaName: string,
  deal: DealMatch,
  row: NormalizedBidBoardRow,
  changedByUserId: string | null
): Promise<EstimateWritebackResult> {
  const route = workflowRoute(deal.workflow_route);
  if (deal.stage_is_terminal || isTerminalWorkflowStage(deal.stage_slug, route)) {
    return {
      updated: false,
      skippedNoValue: false,
      skippedNoChange: false,
      skippedTerminal: true,
      higher: false,
      lower: false,
      warning: `Skipped terminal Bid Board estimate update for deal ${deal.id}: CRM=${deal.stage_slug}, Bid Board=${row.bidBoardStatus ?? "unknown"}`,
    };
  }

  const nextCents = moneyCents(row.bidBoardTotalSales);
  if (nextCents == null || nextCents <= 0) {
    return {
      updated: false,
      skippedNoValue: true,
      skippedNoChange: false,
      skippedTerminal: false,
      higher: false,
      lower: false,
      warning: null,
    };
  }

  if (!changedByUserId) {
    return {
      updated: false,
      skippedNoValue: false,
      skippedNoChange: false,
      skippedTerminal: false,
      higher: false,
      lower: false,
      warning: `Skipped Bid Board estimate update for deal ${deal.id}: no active admin/director user available for audit history`,
    };
  }

  const nextValue = centsToMoneyText(nextCents);
  const updateResult = await client.query(
    `WITH existing AS (
       SELECT bid_estimate
         FROM ${schemaName}.deals
        WHERE id = $1
        FOR UPDATE
     ), updated AS (
       UPDATE ${schemaName}.deals d
          SET bid_estimate = $2::numeric,
              updated_at = NOW()
         FROM existing
        WHERE d.id = $1
          AND existing.bid_estimate IS DISTINCT FROM $2::numeric
        RETURNING existing.bid_estimate AS old_bid_estimate,
                  d.bid_estimate AS new_bid_estimate
     )
     SELECT existing.bid_estimate AS current_bid_estimate,
            updated.old_bid_estimate,
            updated.new_bid_estimate
       FROM existing
       LEFT JOIN updated ON true`,
    [deal.id, nextValue]
  );

  const rowResult = updateResult.rows[0];
  const currentCents = moneyCents(rowResult?.current_bid_estimate ?? deal.bid_estimate);
  if (!rowResult?.new_bid_estimate) {
    return {
      updated: false,
      skippedNoValue: false,
      skippedNoChange: true,
      skippedTerminal: false,
      higher: false,
      lower: false,
      warning: null,
    };
  }

  const oldValue = rowResult.old_bid_estimate == null ? null : String(rowResult.old_bid_estimate);
  const newValue = String(rowResult.new_bid_estimate ?? nextValue);
  await client.query(
    `INSERT INTO ${schemaName}.deal_history
       (deal_id, field_name, old_value, new_value, changed_by, source, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      deal.id,
      "bid_estimate",
      oldValue,
      newValue,
      changedByUserId,
      BID_BOARD_ESTIMATE_SYNC_SOURCE,
      BID_BOARD_ESTIMATE_SYNC_REASON,
    ]
  );

  await logBidBoardActivity(client, schemaName, { ...deal, name: deal.name ?? row.name }, {
    bidEstimate: { from: oldValue, to: newValue },
  }, { source: BID_BOARD_ESTIMATE_SYNC_SOURCE, reason: BID_BOARD_ESTIMATE_SYNC_REASON });

  const higher = currentCents != null && nextCents > currentCents;
  const lower = currentCents != null && nextCents < currentCents;
  const warning =
    currentCents != null && currentCents > 0 && nextCents < currentCents * 0.5
      ? `Large Bid Board estimate decrease for deal ${deal.id}: ${centsToMoneyText(currentCents)} -> ${nextValue}`
      : null;

  return {
    updated: true,
    skippedNoValue: false,
    skippedNoChange: false,
    skippedTerminal: false,
    higher,
    lower,
    warning,
  };
}

async function writeStageIfSafe(
  client: { query: Function },
  schemaName: string,
  deal: DealMatch,
  targetStage: StageConfig,
  row: NormalizedBidBoardRow,
  changedByUserId: string | null
): Promise<StageWritebackResult> {
  const route = workflowRoute(deal.workflow_route);
  const targetSlug = targetStageSlugForDeal(targetStage.slug, route, row);

  if (deal.stage_slug === targetSlug) {
    const refreshed = await updateBidBoardStageMetadata(client, schemaName, deal, deal.stage_id, targetSlug, row);
    if (!refreshed) {
      return {
        updated: false,
        skippedNoStageChange: false,
        appliedBackward: false,
        skippedTerminal: false,
        warning: `Skipped Bid Board stage metadata refresh for deal ${deal.id}: stage changed during sync`,
      };
    }
    return { updated: false, skippedNoStageChange: true, appliedBackward: false, skippedTerminal: false, warning: null };
  }

  if (deal.stage_is_terminal || isTerminalWorkflowStage(deal.stage_slug, route)) {
    return {
      updated: false,
      skippedNoStageChange: false,
      appliedBackward: false,
      skippedTerminal: true,
      warning: `Skipped terminal Bid Board stage update for deal ${deal.id}: CRM=${deal.stage_slug}, Bid Board=${row.bidBoardStatus ?? "unknown"}`,
    };
  }

  // Bid Board is the source of truth for stage: a backward move (target display_order < current,
  // among NON-terminal stages — the terminal lock above already protects Won/Lost) is APPLIED,
  // not pinned. We still detect the direction so it is recorded on the stage-history row
  // (is_backward_move) and surfaced via the appliedBackward metric/log. The stage UPDATE below
  // stamps a fresh stage_entered_at on every move, so the SLA clock resets on re-entry exactly as
  // it does for a forward move.
  const currentOrder = stageOrder(deal.stage_display_order);
  const targetOrder = stageOrder(targetStage.display_order);
  const isBackwardMove = currentOrder != null && targetOrder != null && targetOrder < currentOrder;

  if (!changedByUserId) {
    return {
      updated: false,
      skippedNoStageChange: false,
      appliedBackward: false,
      skippedTerminal: false,
      warning: `Skipped Bid Board stage update for deal ${deal.id}: no active admin/director user available for audit history`,
    };
  }

  const stageFamily = stageFamilyForSlug(targetSlug);
  const status = row.bidBoardStatus ?? targetSlug;
  const stageChangedAt = new Date();
  const stageEntryHoldState = getHoldStateAtStageEntry(
    {
      onHold: Boolean(deal.on_hold),
      onHoldStartedAt: deal.on_hold_started_at,
      onHoldAccumulatedSeconds: Number(deal.on_hold_accumulated_seconds ?? 0),
    },
    stageChangedAt
  );
  const updateResult = await client.query(
    `UPDATE ${schemaName}.deals
        SET stage_id = $1,
            stage_entered_at = $2::timestamptz,
            on_hold_started_at = $3::timestamptz,
            on_hold_accumulated_seconds = $4::bigint,
            on_hold_accumulated_seconds_at_stage_entry = $5::bigint,
            is_bid_board_owned = true,
            bid_board_stage_slug = $6::text,
            bid_board_stage_family = $7::text,
            bid_board_stage_status = $8::text,
            bid_board_stage_entered_at = NOW(),
            read_only_synced_at = NOW(),
            actual_close_date = CASE WHEN $6::text = 'won' THEN COALESCE(actual_close_date, CURRENT_DATE) ELSE actual_close_date END,
            lost_at = CASE WHEN $6::text = 'lost' THEN COALESCE(lost_at, NOW()) ELSE lost_at END,
            bid_board_loss_outcome = CASE WHEN $6::text = 'lost' THEN COALESCE(bid_board_loss_outcome, $8::text) ELSE bid_board_loss_outcome END,
            updated_at = NOW()
      WHERE id = $9
        AND stage_id = $10
      RETURNING id`,
    [
      targetStage.id,
      stageChangedAt,
      stageEntryHoldState.onHoldStartedAt,
      stageEntryHoldState.onHoldAccumulatedSeconds,
      stageEntryHoldState.onHoldAccumulatedSecondsAtStageEntry,
      targetSlug,
      stageFamily,
      status,
      deal.id,
      deal.stage_id,
    ]
  );

  if ((updateResult.rowCount ?? 0) === 0) {
    return {
      updated: false,
      skippedNoStageChange: false,
      appliedBackward: false,
      skippedTerminal: false,
      warning: `Skipped Bid Board stage update for deal ${deal.id}: stage changed during sync`,
    };
  }

  await client.query(
    `INSERT INTO ${schemaName}.deal_stage_history
       (deal_id, from_stage_id, to_stage_id, changed_by, is_backward_move,
        is_director_override, override_reason, duration_in_previous_stage)
     VALUES ($1, $2, $3, $4, $5, false, $6,
       CASE WHEN $7::timestamptz IS NULL THEN NULL ELSE NOW() - $7::timestamptz END)`,
    [
      deal.id,
      deal.stage_id,
      targetStage.id,
      changedByUserId,
      isBackwardMove,
      `Bid Board export sync${isBackwardMove ? " (backward)" : ""} - Status ${status} -> Stage ${targetSlug}`,
      deal.stage_entered_at,
    ]
  );

  await logBidBoardActivity(client, schemaName, { ...deal, name: deal.name ?? row.name }, {
    stageId: { from: deal.stage_id, to: targetStage.id },
    bidBoardStageSlug: { from: deal.bid_board_stage_slug, to: targetSlug },
    bidBoardStageFamily: { from: deal.bid_board_stage_family, to: stageFamily },
    bidBoardStageStatus: { from: deal.bid_board_stage_status, to: status },
    readOnlySyncedAt: { from: null, to: "now" },
  }, { source: "stage_writeback", bidBoardStatus: row.bidBoardStatus });

  return { updated: true, skippedNoStageChange: false, appliedBackward: isBackwardMove, skippedTerminal: false, warning: null };
}

export async function ingestBidBoardRows(payload: BidBoardSyncPayload) {
  const rows = extractRows(payload);
  const officeSlug = normalizeOfficeSlug(payload);
  const schemaName = validateSchemaName(`office_${officeSlug}`);
  const sourceFilename =
    textValue(payload.provenance?.sourceFilename) ?? textValue(payload.provenance?.source_filename);
  const extractedAt =
    textValue(payload.provenance?.extractedAt) ?? textValue(payload.provenance?.extracted_at);
  const bidBoardLastUpdatedAt = extractedAt ?? new Date().toISOString();
  const payloadHash = hashRows(rows);
  const warnings: string[] = [];
  const errors: string[] = [];
  const unmatchedProjectNumbers: string[] = [];
  const metrics: IngestionMetrics = {
    rowsReceived: rows.length,
    updated: 0,
    matched: 0,
    stageUpdated: 0,
    noMatch: 0,
    multiMatch: 0,
    warnings: 0,
    duplicateProjectNumbers: 0,
    nullProjectNumbers: 0,
    invalidDueDates: 0,
    skippedNoProjectNumber: 0,
    skippedUnmappedStatus: 0,
    skippedTemplate: 0,
    appliedBackward: 0,
    skippedTerminal: 0,
    skippedNoStageChange: 0,
    estimateUpdated: 0,
    estimateUpdatedHigher: 0,
    estimateUpdatedLower: 0,
    estimateSkippedNoValue: 0,
    estimateSkippedNoChange: 0,
    estimateSkippedTerminal: 0,
    estimateWarnings: 0,
  };

  const seenProjectNumbers = new Set<string>();
  const duplicateProjectNumbers = new Set<string>();
  for (const row of rows) {
    const projectNumber = normalizeBidBoardProjectNumber(row["Project #"]);
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
    // This sync writes deal_stage_history explicitly on every stage writeback (below), so
    // suppress the deal_stage_history backstop trigger (migration 0143) for this transaction
    // to avoid double-recording. Transaction-local; auto-clears at COMMIT/ROLLBACK.
    await client.query("SELECT set_config('app.skip_stage_history_trigger', '1', true)");

    const runResult = await client.query(
      `INSERT INTO ${schemaName}.bid_board_sync_runs
       (source_filename, extracted_at, payload_hash, row_count, status)
       VALUES ($1, $2::timestamptz, $3, $4, 'processing')
       RETURNING id`,
      [sourceFilename, extractedAt, payloadHash, rows.length]
    );
    runId = runResult.rows[0]?.id ?? null;

    const updateSql = buildBidBoardDealUpdateSql(schemaName);
    const changedByUserId = await findSystemChangedByUserId(client, officeSlug);

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
        metrics.skippedNoProjectNumber++;
        warnings.push(`Bid Board row "${normalized.name}" has NULL Project #`);
        continue;
      }
      if (isTemplatesStatus(normalized.bidBoardStatus)) {
        metrics.skippedTemplate++;
        continue;
      }

      const matches = await findDealMatches(client, schemaName, normalized);
      if (matches.length === 0) {
        metrics.noMatch++;
        if (unmatchedProjectNumbers.length < MAX_UNMATCHED_PROJECT_NUMBERS) {
          unmatchedProjectNumbers.push(normalized.bidBoardProjectNumber);
        }
        if (STRUCTURED_PROJECT_NUMBER_PATTERN.test(normalized.bidBoardProjectNumber)) {
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

      metrics.matched++;
      const updateResult = await client.query(updateSql, updateParams(matches[0].id, normalized, bidBoardLastUpdatedAt));
      if ((updateResult.rowCount ?? 0) > 0) {
        metrics.updated++;
        const updateDeal = updateResult.rows?.[0] ?? matches[0];
        await logBidBoardActivity(
          client,
          schemaName,
          updateDeal,
          buildBidBoardMirrorFieldChanges(matches[0], normalized, bidBoardLastUpdatedAt),
          { source: "bid_board_mirror", runId }
        );
      }

      const estimateResult = await writeEstimateIfNeeded(client, schemaName, matches[0], normalized, changedByUserId);
      if (estimateResult.updated) metrics.estimateUpdated++;
      if (estimateResult.higher) metrics.estimateUpdatedHigher++;
      if (estimateResult.lower) metrics.estimateUpdatedLower++;
      if (estimateResult.skippedNoValue) metrics.estimateSkippedNoValue++;
      if (estimateResult.skippedNoChange) metrics.estimateSkippedNoChange++;
      if (estimateResult.skippedTerminal) metrics.estimateSkippedTerminal++;
      if (estimateResult.warning) {
        metrics.estimateWarnings++;
        warnings.push(estimateResult.warning);
      }

      const targetStageSlug = bidBoardStatusToCrmStage(normalized.bidBoardStatus);
      if (!targetStageSlug) {
        metrics.skippedUnmappedStatus++;
        warnings.push(
          `Skipped Bid Board stage writeback for ${normalized.bidBoardProjectNumber}: unmapped status ${normalized.bidBoardStatus ?? "NULL"}`
        );
        continue;
      }

      const route = workflowRoute(matches[0].workflow_route);
      const targetStage = await findTargetStage(client, targetStageSlugForDeal(targetStageSlug, route, normalized));
      if (!targetStage) {
        metrics.skippedUnmappedStatus++;
        warnings.push(`Skipped Bid Board stage writeback for ${normalized.bidBoardProjectNumber}: CRM stage ${targetStageSlug} not found`);
        continue;
      }

      const stageResult = await writeStageIfSafe(client, schemaName, matches[0], targetStage, normalized, changedByUserId);
      if (stageResult.updated) metrics.stageUpdated++;
      if (stageResult.skippedNoStageChange) metrics.skippedNoStageChange++;
      if (stageResult.appliedBackward) {
        metrics.appliedBackward++;
        console.info(
          `[BidBoardSync] Applied backward stage move for deal ${matches[0].id}: ${matches[0].stage_slug} -> ${targetStage.slug} (Bid Board is source of truth)`
        );
      }
      if (stageResult.skippedTerminal) metrics.skippedTerminal++;
      if (stageResult.warning) warnings.push(stageResult.warning);
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
              warnings = $8::jsonb,
              matched_count = $9,
              stage_updated_count = $10,
              skipped_no_project_number_count = $11,
              skipped_unmapped_status_count = $12,
              skipped_template_count = $13,
              applied_backward_count = $14,
              skipped_terminal_count = $15,
              skipped_no_stage_change_count = $16,
              unmatched_project_numbers = $17::jsonb,
              estimate_updated_count = $18,
              estimate_updated_higher_count = $19,
              estimate_updated_lower_count = $20,
              estimate_skipped_no_value_count = $21,
              estimate_skipped_no_change_count = $22,
              estimate_warning_count = $23,
              estimate_skipped_terminal_count = $24
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
        metrics.matched,
        metrics.stageUpdated,
        metrics.skippedNoProjectNumber,
        metrics.skippedUnmappedStatus,
        metrics.skippedTemplate,
        metrics.appliedBackward,
        metrics.skippedTerminal,
        metrics.skippedNoStageChange,
        JSON.stringify(unmatchedProjectNumbers),
        metrics.estimateUpdated,
        metrics.estimateUpdatedHigher,
        metrics.estimateUpdatedLower,
        metrics.estimateSkippedNoValue,
        metrics.estimateSkippedNoChange,
        metrics.estimateWarnings,
        metrics.estimateSkippedTerminal,
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
