import crypto from "crypto";
import {
  getHoldStateAtStageEntry,
  isGenuineWonDealStageSlug,
  isTerminalWorkflowStage,
  type WorkflowRoute,
} from "@trock-crm/shared/types";
import { bidBoardStatusToCrmStage, normalizeBidBoardStatus } from "@trock-crm/shared/lib/bidBoardStatusMap";
import { pool, releasePooledClient, isBrokenConnectionError } from "../../db.js";
import { isBidBoardDueDateReadbackEnabled } from "../../config/feature-flags.js";
import { bidDueDateToDateOnly, dateOnlyToUtcMidnightIso } from "../deals/bid-due-date.js";
import { effectiveContractSignedDate, resolveWonClosedDateWriteThrough } from "../shared/won-close-date.js";
import { AppError } from "../../middleware/error-handler.js";
import { buildAuditActorFromSystem } from "../audit/audit-logger.js";
import { logActivityWithPgClient } from "../audit/pg-activity-logger.js";
import { BID_BOARD_SYNC } from "../audit/system-processes.js";
import { canonicalizeProjectNumber, canonicalProjectNumberSql } from "./project-number.js";
import {
  buildEstimatorDirectory,
  isEstimatorResolutionConfigured,
  normalizeEstimatorKey,
  resolveEstimatorUserId,
  type EstimatorDirectory,
} from "./estimator-map.js";

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
  appliedTerminalExit: number;
  skippedTerminal: number;
  skippedNoStageChange: number;
  // Rows whose CRM deal exists but was moved back to Opportunity (detached from Bid Board, migration
  // 0200). Kept OUT of noMatch on purpose: folding them in would flip every later run to
  // 'completed_with_unmatched' and append the same project number to unmatched_project_numbers forever.
  skippedDetached: number;
  estimateUpdated: number;
  estimateUpdatedHigher: number;
  estimateUpdatedLower: number;
  estimateSkippedNoValue: number;
  estimateSkippedNoChange: number;
  estimateSkippedTerminal: number;
  estimateWarnings: number;
  // Bid Board Due Date -> deals.bid_due_date read-back (BID_BOARD_DUE_DATE_READBACK). All three stay 0
  // while the flag is off, because the write-through is not even called. Only bidDueDateUpdated is
  // persisted on the run row; the two skip counters are in-process/log signal, exactly like the estimate
  // skips that also have no column.
  bidDueDateUpdated: number;
  bidDueDateSkippedNoValue: number;
  bidDueDateSkippedNoChange: number;
  /**
   * Deals whose bid_due_date already matched the Board, so nothing was written, but whose PROVENANCE was
   * (re-)stamped — which is what makes them eligible for the read override. Distinct from
   * bidDueDateUpdated because no value moved, and from bidDueDateSkippedNoChange because something did.
   */
  bidDueDateProvenanceStamped: number;
  /** Matched rows whose due-date write was refused for lack of an admin/director to attribute it to. */
  bidDueDateSkippedNoAttributor: number;
  /**
   * Matched rows refused because this payload carries the same canonical Project # more than once with
   * DIFFERENT Due Dates. Writing them would let export order decide which date — and therefore which
   * auto-park horizon — lands on the deal.
   */
  bidDueDateSkippedDuplicateProjectNumber: number;
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
  estimator_user_id: string | null;
  sales_source_user_id: string | null;
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
  awarded_amount: string | null;
  // Won-period reporting basis (migration 0141): the bid-board mirror keeps won_closed_date in
  // lockstep with Won status. contract_signed_* are the accounting override fed into the canonical
  // resolveWonClosedDateWriteThrough — same convention as changeDealStage.
  won_closed_date: string | null;
  contract_signed_date: string | null;
  contract_signed_at: string | null;
  /** Non-null once "Move back to Opportunity" severed this deal from Bid Board sync (migration 0200). */
  bid_board_detached_at: string | null;
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

const MAX_UNMATCHED_PROJECT_NUMBERS = 100;
const BID_BOARD_ESTIMATE_SYNC_SOURCE = "bid_board_sync";
const BID_BOARD_ESTIMATE_SYNC_REASON = "Bid Board export sync - Total Sales -> Bid Estimate";
const BID_BOARD_DUE_DATE_SYNC_SOURCE = "bid_board_sync";
const BID_BOARD_DUE_DATE_SYNC_REASON = "Bid Board export sync - Due Date -> Bid Due Date";
const BID_BOARD_MIRROR_UPDATE_SAVEPOINT = "bid_board_mirror_update";
const BID_BOARD_PROJECT_NUMBER_UNIQUE_CONSTRAINT = "deals_bid_board_project_number_canonical_uidx";

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

/**
 * Parse the calendar day out of a Bid Board export date STRING as a UTC instant, timezone-independently.
 *
 * `new Date(str)` is only safe for the two forms it defines as UTC: a bare "YYYY-MM-DD" and an
 * offset-qualified timestamp. The Procore export's real shape is US "M/D/YYYY", which V8 parses in the
 * SESSION timezone — so `new Date("4/30/2026").toISOString().slice(0, 10)` is 2026-04-30 under TZ=UTC and
 * 2026-04-29 under Europe/Berlin. Prod runs Etc/UTC today, so this has been latent; it stops being
 * acceptable now that the parsed day is written to `deals.bid_due_date`, which is the auto-park horizon
 * for estimating deals — one wrong day there flips a deal's hold verdict and zeroes (or restores) its
 * reported value. Reading the day off the string rather than off a locally-parsed instant removes the
 * dependency entirely instead of relying on a deployment detail.
 *
 * `recognized` is deliberately separate from `date`: a string that MATCHES a known shape but names an
 * impossible day (2/31/2026, 13/01/2026) must be reported as invalid, NOT handed to `new Date(...)`, which
 * silently rolls it over into a different, entirely plausible day (2026-03-03). A wrong-but-plausible
 * horizon is worse than a null one — the null is visible in invalidDueDates and never written, while the
 * rollover would park or un-park a real deal against a date nobody entered.
 */
function parseExportDateStringUtc(text: string): { recognized: boolean; date: Date | null } {
  /** Date.UTC, but null for a day that does not exist rather than the rolled-over neighbour. */
  const utcDay = (year: number, month: number, day: number): Date | null => {
    const probe = new Date(Date.UTC(year, month - 1, day));
    if (
      probe.getUTCFullYear() !== year ||
      probe.getUTCMonth() !== month - 1 ||
      probe.getUTCDate() !== day
    ) {
      return null;
    }
    return probe;
  };

  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s]|$)/.exec(text);
  if (iso) {
    return { recognized: true, date: utcDay(Number(iso[1]), Number(iso[2]), Number(iso[3])) };
  }
  // US M/D/YYYY (or MM/DD/YYYY), optionally followed by a time we deliberately discard — the business
  // value is a calendar day.
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[\s,]|$)/.exec(text);
  if (us) {
    return { recognized: true, date: utcDay(Number(us[3]), Number(us[1]), Number(us[2])) };
  }
  return { recognized: false, date: null };
}

export function parseBidBoardDueDate(
  value: unknown,
  projectName = "unknown project",
  // What the ingest will DO with the unusable value, so the warning can describe the write that actually
  // happens. Defaults to false = main's behaviour (the mirror column is overwritten with NULL).
  options: { preserveBlankDueDate?: boolean } = {}
): { value: string | null; warning: string | null } {
  if (value == null || value === "") return { value: null, warning: null };
  // A string in a KNOWN export shape is resolved by this parser and never by `new Date(...)` — including
  // when it is invalid, so an impossible day is reported rather than rolled over. Only an unrecognised
  // shape falls through to the engine's own parsing, preserving whatever the export used to accept.
  const parsedText =
    typeof value === "string" ? parseExportDateStringUtc(value.trim()) : { recognized: false, date: null };
  const date =
    typeof value === "number"
      ? parseExcelSerialDate(value)
      : value instanceof Date
        ? value
        : parsedText.recognized
          ? parsedText.date ?? new Date(NaN)
          : new Date(String(value));

  // The operator reads these warnings to decide whether the sync did something surprising, so they must
  // name the write that ACTUALLY happened. With the read-back on, an unusable value is not stored at all:
  // bid_board_due_date goes through COALESCE($11::date, bid_board_due_date), so the last date the Board
  // gave us survives — and "was stored as NULL" would describe a write that did not occur, which is worse
  // than saying nothing. With the flag off the column really is cleared, and the original wording holds.
  const outcome = options.preserveBlankDueDate
    ? "was ignored (the previously synced Bid Board due date is left unchanged)"
    : "was stored as NULL";

  if (Number.isNaN(date.getTime())) {
    return {
      value: null,
      warning: `Due Date for ${projectName} could not be parsed and ${outcome}`,
    };
  }

  const year = date.getUTCFullYear();
  if (year < 2020 || year > 2050) {
    return {
      value: null,
      warning: `Due Date for ${projectName} is outside accepted range (${year}) and ${outcome}`,
    };
  }

  return { value: date.toISOString().slice(0, 10), warning: null };
}

export function normalizeBidBoardProjectNumber(value: unknown): string | null {
  // Canonicalize so visually-identical project numbers (Unicode dash glyphs, NBSP, case,
  // surrounding whitespace) match. MUST mirror canonicalProjectNumberSql used on the deal
  // columns and the migration 0149 unique index.
  return canonicalizeProjectNumber(value);
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

export function buildBidBoardDealUpdateSql(
  schemaName: string,
  // Flag-gated, DEFAULT FALSE = today's behaviour on main. See the bid_board_due_date SET clause below.
  options: { preserveBlankDueDate?: boolean } = {}
): string {
  const schema = validateSchemaName(schemaName);
  // FLAG OFF must be byte-for-byte main: `bid_board_due_date = $11`, so a blank export CLEARS the mirror.
  // That is externally visible even with the read-back off — the flag-off RFP payload still passes the
  // mirror to SyncHub as its dueDate fallback, so preserving a stale date here would send one onward to
  // Procore where main sent null. Parity is not negotiable for a value that leaves the CRM.
  const bidBoardDueDateSet = options.preserveBlankDueDate
    ? "COALESCE($11::date, bid_board_due_date)"
    : "$11";
  const bidBoardDueDateChanged = options.preserveBlankDueDate
    ? "($11::date IS NOT NULL AND bid_board_due_date IS DISTINCT FROM $11::date)"
    : "bid_board_due_date IS DISTINCT FROM $11";
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
           -- FLAG ON: non-clearing, unlike every other mirror column here. A BLANK export Due Date is the
           -- ABSENCE of information, not an instruction to forget the last one the board gave us, so the
           -- column means "last known Bid Board due date" and $11 only ever overwrites it with another
           -- date. Load-bearing for the read-back: writeBidDueDateIfNeeded already refuses to clear
           -- deals.bid_due_date on a blank Due Date (same rule), and the resolver's CURRENCY check asks
           -- whether the written day still equals this mirror. A blank cell wiping the mirror while the
           -- written date stayed would revoke the override unannounced, from an empty spreadsheet cell,
           -- with nobody having touched anything. Verified before changing: nothing else in the repo reads
           -- this column except the RFP payload and the audit mirror below.
           --
           -- FLAG OFF: a plain $11, clearing exactly as main does — see this function's header.
           bid_board_due_date = ${bidBoardDueDateSet},
           bid_board_customer_name = $12,
           bid_board_customer_contact_raw = $13,
           bid_board_project_number = $14,
           -- Empties-only estimator fill, TOCTOU-guarded against the LIVE locked row: NULLIF drops the
           -- incoming id when it equals the deal's CURRENT sales_source_user_id, so an admin setting the
           -- source to the mapped estimator between findDealMatches (the snapshot the JS guard reads) and
           -- this UPDATE's row lock can never recreate the estimator == source conflict.
           estimator_user_id = COALESCE(estimator_user_id, NULLIF($16::uuid, sales_source_user_id)),
           -- Bid Board exports do not include a per-row updated-at, so this stores the sync cycle timestamp.
           bid_board_last_updated_at = $15::timestamptz,
           updated_at = NOW()
     WHERE id = $1
       -- Belt-and-braces: the matcher already excludes detached deals, but this mirror UPDATE keys on a
       -- bare id, so any future caller that bypasses findDealMatches would silently overwrite a detached
       -- deal's name and mirror fields. Repeating the predicate at the write site makes the invariant
       -- local instead of depending on one caller staying correct.
       AND bid_board_detached_at IS NULL
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
            -- Matches the SET clause above. Flag on, a NULL $11 writes nothing, so it must not make the
            -- row look dirty either (that would churn updated_at every cycle for a project whose Due Date
            -- cell is permanently blank). Flag off, the plain main-parity comparison.
            ${bidBoardDueDateChanged} OR
            bid_board_customer_name IS DISTINCT FROM $12 OR
            bid_board_customer_contact_raw IS DISTINCT FROM $13 OR
            bid_board_project_number IS DISTINCT FROM $14 OR
            bid_board_last_updated_at IS DISTINCT FROM $15::timestamptz OR
            -- Only trigger an estimator-fill write when it would actually land: the incoming id is set,
            -- the slot is empty, AND it isn't the live sales source (matches the NULLIF guard above, so
            -- the UPDATE doesn't churn updated_at just to no-op a blocked fill).
            (estimator_user_id IS NULL AND $16::uuid IS NOT NULL AND $16::uuid IS DISTINCT FROM sales_source_user_id)
       )
     RETURNING id, name, deal_number, project_number, estimator_user_id
  `;
}

export function updateParams(
  dealId: string,
  row: NormalizedBidBoardRow,
  bidBoardLastUpdatedAt: string,
  estimatorUserId: string | null
) {
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
    estimatorUserId,
  ];
}

function isCanonicalBidBoardProjectNumberUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const pgError = err as { code?: unknown; constraint?: unknown; message?: unknown };
  const message = typeof pgError.message === "string" ? pgError.message : "";
  return (
    pgError.code === "23505" &&
    (pgError.constraint === BID_BOARD_PROJECT_NUMBER_UNIQUE_CONSTRAINT ||
      message.includes(BID_BOARD_PROJECT_NUMBER_UNIQUE_CONSTRAINT))
  );
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
           d.estimator_user_id,
           d.sales_source_user_id,
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
           d.awarded_amount,
           d.won_closed_date,
           d.contract_signed_date,
           d.contract_signed_at,
           d.bid_board_detached_at,
           psc.slug AS stage_slug,
           psc.display_order AS stage_display_order,
           psc.is_terminal AS stage_is_terminal
      FROM ${schemaName}.deals d
      LEFT JOIN public.pipeline_stage_config psc ON psc.id = d.stage_id
     -- Change-order CHILD deals are CRM-only and MUST never be matched/synced to Bid Board: they
     -- share the parent's project_number, so without this exemption the project_number tier below would
     -- return parent+child as a multi-match and silently skip the PARENT's writeback (the Onyx desync
     -- class). This base WHERE feeds all three match tiers (procore_bid_id, project_number/deal_number,
     -- name+date), so the one predicate covers every path that keys on project_number.
     --
     -- The DETACH marker (migration 0200) is deliberately NOT filtered here. A deal moved back to
     -- Opportunity keeps every identity column — nulling them would make the SyncHub webhook INSERT a
     -- twin — so the marker is the only thing stopping the export re-claiming it, and the caller acts on
     -- it. It used to be a WHERE predicate flipped between two separate queries per tier, which under
     -- READ COMMITTED could lose a deal ENTIRELY: a bid-board-created callback reattaching it between
     -- the two statements makes the attached query miss it (still detached when that ran) and the
     -- detached query miss it too (marker cleared by the time this ran). The row then fell to a weaker
     -- identity tier and could bind to a DIFFERENT deal, mirroring one project's name, estimate and
     -- stage onto another's. Selecting bid_board_detached_at and partitioning in memory means both
     -- halves come from ONE snapshot, so no attachment transition can make a high-confidence match
     -- disappear between them.
     WHERE d.is_active = true
       AND COALESCE(d.is_change_order, false) = false`;
}

/**
 * The three identity tiers, in DESCENDING confidence, as (sql, params) pairs so each can be run against
 * attached or detached deals without the tier logic being written twice.
 *  1. procore_bid_id — the Bid Board's own key.
 *  2. project_number / deal_number / bid_board_project_number, canonicalized.
 *  3. name + bid_board_created_at, for a deal with no bid_board_project_number.
 */
function dealMatchTiers(
  schemaName: string,
  row: NormalizedBidBoardRow
): Array<{ sql: string; params: unknown[] }> {
  const tiers: Array<{ sql: string; params: unknown[] }> = [];

  if (row.bidBoardProjectId) {
    tiers.push({
      sql: `${dealMatchSelectSql(schemaName)}
       AND d.procore_bid_id = $1::bigint`,
      params: [row.bidBoardProjectId],
    });
  }

  const projectNumber = normalizeBidBoardProjectNumber(row.bidBoardProjectNumber);
  if (projectNumber) {
    tiers.push({
      sql: `${dealMatchSelectSql(schemaName)}
       AND (
            ${canonicalProjectNumberSql("d.project_number")} = $1 OR
            ${canonicalProjectNumberSql("d.deal_number")} = $1 OR
            ${canonicalProjectNumberSql("d.bid_board_project_number")} = $1
       )`,
      params: [projectNumber],
    });
  }

  if (row.bidBoardCreatedAt) {
    tiers.push({
      sql: `${dealMatchSelectSql(schemaName)}
        AND d.bid_board_project_number IS NULL
        AND LOWER(TRIM(d.name)) = LOWER(TRIM($1))
        AND d.bid_board_created_at = $2::timestamptz`,
      params: [row.name, row.bidBoardCreatedAt],
    });
  }

  return tiers;
}

/**
 * Resolve an export row to a CRM deal, TIER BY TIER, evaluating BOTH partitions (attached and detached)
 * at each tier before dropping to a weaker one.
 *
 * Two separate invariants live here, and both were learned the hard way:
 *
 *  1. TIER PRIORITY. Running every attached tier first and only then looking for detached deals loses
 *     tier priority: an export row whose exact `procore_bid_id` belongs to a detached deal would fall
 *     through tier 1 and could then bind to a DIFFERENT deal on the weaker project-number or
 *     name+created-at tiers — writing one project's name, estimate and stage onto another project's
 *     deal. A detached hit at a higher-confidence tier IS the answer; the search stops there.
 *
 *  2. AMBIGUITY. The detach predicate partitions what used to be one result set, so ambiguity has to be
 *     judged across BOTH halves or the partition itself hides it. If an attached and a detached deal
 *     share an identifier at the same tier, the attached half alone looks like a clean single match —
 *     and the caller's `matches.length > 1` guard, which exists precisely to refuse an ambiguous write,
 *     never fires. Both queries always run at a tier that matches anything, and their rows are counted
 *     together: >1 is returned as `matches` so the caller's existing multi-match guard skips the row and
 *     an operator reconciles it, exactly as it would have before deals could be detached.
 *
 * Cost: two indexed lookups per tier examined instead of one, bounded at three tiers. The detached side
 * is served by the partial `deals_bid_board_detached_idx` over a near-empty set, and this is a batched
 * import job, so the trade for not silently writing an ambiguous row is a good one.
 */
async function resolveDealMatches(
  client: { query: Function },
  schemaName: string,
  row: NormalizedBidBoardRow
): Promise<{ matches: DealMatch[]; detached: DealMatch[] }> {
  for (const tier of dealMatchTiers(schemaName, row)) {
    // ONE statement per tier, partitioned here. Two statements could straddle a reattachment and lose
    // the deal from both halves — see dealMatchSelectSql.
    const result = await client.query(tier.sql, tier.params);
    const rows = result.rows as DealMatch[];
    const attached = rows.filter((match) => match.bid_board_detached_at == null);
    const detached = rows.filter((match) => match.bid_board_detached_at != null);
    const total = rows.length;

    if (total === 0) continue;
    // Ambiguous ACROSS the partition — hand the whole set back as matches so the caller's multi-match
    // guard refuses the write. A detached deal counts toward ambiguity deliberately: "this identifier
    // also belongs to a deal someone deliberately disconnected" is a reason to stop, not to proceed.
    if (total > 1) return { matches: [...attached, ...detached], detached: [] };
    if (detached.length === 1) return { matches: [], detached };
    return { matches: attached, detached: [] };
  }

  return { matches: [], detached: [] };
}

async function findDealMatches(
  client: { query: Function },
  schemaName: string,
  row: NormalizedBidBoardRow
): Promise<DealMatch[]> {
  return (await resolveDealMatches(client, schemaName, row)).matches;
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

/** Existing active user ids, used to keep a misconfigured estimator map id from FK-violating. */
async function loadActiveUserIds(client: { query: Function }): Promise<Set<string>> {
  const result = await client.query(`SELECT id FROM public.users WHERE is_active = true`);
  return new Set((result.rows ?? []).map((r: { id: string }) => r.id));
}

/**
 * The `estimates_jobs` half of estimator resolution (see estimator-map.ts).
 *
 * `is_active` is applied HERE rather than left to the activeUserIds gate downstream, so an inactive
 * estimator's name cannot even claim a directory entry — if it did, and a second ACTIVE user shared
 * that display name, the inactive one would poison the key as ambiguous and block a resolution that
 * should have succeeded.
 */
async function loadEstimatorDirectory(client: { query: Function }): Promise<EstimatorDirectory> {
  const result = await client.query(
    `SELECT id, display_name FROM public.users WHERE is_active = true AND estimates_jobs = true`
  );
  return buildEstimatorDirectory(
    (result.rows ?? []).map((r: { id: string; display_name: string | null }) => ({
      id: r.id,
      displayName: r.display_name,
    }))
  );
}

function workflowRoute(value: string | null): WorkflowRoute {
  return value === "service" ? "service" : "normal";
}

function stageOrder(value: number | string | null | undefined): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The deal's stored won_closed_date as YYYY-MM-DD — the stage-driven won date that is PRESERVED
 * verbatim when a deal moves between Won stages (matches changeDealStage / setDealContractSignedDate).
 * Tolerates either a date-only string (node-pg DATE) or a Date/timestamp.
 */
function toDateOnlyString(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  const text = String(value);
  return text.length >= 10 ? text.slice(0, 10) : text || null;
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

function buildBidBoardMirrorFieldChanges(deal: DealMatch, row: NormalizedBidBoardRow, bidBoardLastUpdatedAt: string, estimatorUserId: string | null, preserveBlankDueDate: boolean) {
  return {
    name: { from: deal.name, to: row.name },
    bidBoardEstimator: { from: deal.bid_board_estimator, to: row.bidBoardEstimator },
    estimatorUserId: { from: deal.estimator_user_id, to: estimatorUserId },
    bidBoardOffice: { from: deal.bid_board_office, to: row.bidBoardOffice },
    bidBoardStatus: { from: deal.bid_board_status, to: row.bidBoardStatus },
    bidBoardSalesPricePerArea: { from: deal.bid_board_sales_price_per_area, to: row.bidBoardSalesPricePerArea },
    bidBoardProjectCost: { from: deal.bid_board_project_cost, to: row.bidBoardProjectCost },
    bidBoardProfitMarginPct: { from: deal.bid_board_profit_margin_pct, to: row.bidBoardProfitMarginPct },
    bidBoardTotalSales: { from: deal.bid_board_total_sales, to: row.bidBoardTotalSales },
    bidBoardCreatedAt: { from: deal.bid_board_created_at, to: row.bidBoardCreatedAt },
    // `to` mirrors whichever SET clause buildBidBoardDealUpdateSql emitted: with the read-back on a blank
    // export leaves the column alone, so the audit trail must not claim a clear that did not happen; with
    // it off the column really is cleared and the trail must say so.
    bidBoardDueDate: {
      from: deal.bid_board_due_date,
      to: preserveBlankDueDate ? row.bidBoardDueDate ?? deal.bid_board_due_date : row.bidBoardDueDate,
    },
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
        AND stage_id = $5
        -- This is the easy one to miss: it fires on a cycle where the CRM stage ALREADY equals the
        -- mapped Bid Board stage, and it re-asserts is_bid_board_owned = true. Without the predicate a
        -- detached deal that happens to sit at the mapped stage would be silently re-owned.
        AND bid_board_detached_at IS NULL`,
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
  appliedTerminalExit: boolean;
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

/**
 * The per-row outcome. EXACTLY ONE of `updated` / `provenanceStamped` / `skippedNoValue` /
 * `skippedNoChange` / `skippedNoAttributor` is true, so the metrics they feed sum to `matched` over a run
 * (the one documented exception being a row whose mirror UPDATE hit the canonical-project-number unique
 * violation and `continue`d before this function was reached).
 */
interface BidDueDateWritebackResult {
  updated: boolean;
  skippedNoValue: boolean;
  skippedNoChange: boolean;
  /** No admin/director to attribute the deal_history row to, so the write was refused. */
  skippedNoAttributor?: boolean;
  /** The value was already correct, but the Board's confirmation was newly recorded (the 0225 stamps). */
  provenanceStamped?: boolean;
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
          -- Detached deals keep their own estimate: without this the Bid Board would keep overwriting
          -- bid_estimate on a deal it no longer owns (the CTE returns no row, so the caller reads
          -- skippedNoChange and nothing is written).
          AND bid_board_detached_at IS NULL
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

/**
 * Bid Board Due Date -> `deals.bid_due_date`. Gated by BID_BOARD_DUE_DATE_READBACK; the caller does not
 * even invoke this while the flag is off, so flag-off issues NO query.
 *
 * THIS WRITE MOVES REPORTED DOLLARS. Since 2026-07-27 `bid_due_date` is the auto-park HORIZON for genuine
 * estimating-stage deals ([[deal-hold-risk]] / holdHorizonDateSql), so a date more than 90 CT-days out
 * makes the deal effectively on hold and zeroes its value on cards, dashboards, at-risk counts and the
 * worker rollups — and a nearer date UN-parks a deal that a far-out close target had parked. Both
 * directions are real; the census script quantifies them before the flag is flipped.
 *
 * Three deliberate rules:
 *  - BLANK NEVER CLEARS. A Procore field nobody filled in, or one export where the column fails to
 *    populate, must not wipe a date reps rely on. Counted as skippedNoValue and nothing is touched.
 *  - APPLIES REGARDLESS OF STAGE, unlike the estimate and stage writebacks. There is no financial or
 *    attribution consequence to correcting a historical deal's bid date (the hold horizon's far-out leg is
 *    terminal-exempt server-side), and skipping terminal deals would leave permanent drift against the
 *    board.
 *  - IS DISTINCT FROM guard, so a repeat sync of an unchanged date writes nothing at all — no updated_at
 *    churn, no history row, no audit noise on a job that runs on a schedule.
 */
async function writeBidDueDateIfNeeded(
  client: { query: Function },
  schemaName: string,
  deal: DealMatch,
  row: NormalizedBidBoardRow,
  changedByUserId: string | null
): Promise<BidDueDateWritebackResult> {
  // parseBidBoardDueDate already returned a validated date-only "YYYY-MM-DD" (or null for blank/garbage/
  // out-of-range, which the caller has already warned about).
  const nextDay = row.bidBoardDueDate;
  if (!nextDay) {
    return {
      updated: false,
      skippedNoValue: true,
      skippedNoChange: false,
      provenanceStamped: false,
      warning: null,
    };
  }

  if (!changedByUserId) {
    // Same posture as the estimate path: deal_history.changed_by is the audit trail for a value change
    // that moves money, so we skip the write entirely rather than record an unattributable one.
    //
    // Counted under its OWN metric. Previously this path incremented nothing, so a run where no
    // admin/director existed produced per-row outcomes that silently failed to add up to `matched` —
    // the looseness that made the double-count above hard to notice.
    return {
      updated: false,
      skippedNoValue: false,
      skippedNoChange: false,
      skippedNoAttributor: true,
      provenanceStamped: false,
      warning: `Skipped Bid Board bid due date update for deal ${deal.id}: no active admin/director user available for audit history`,
    };
  }

  // UTC midnight — the convention every other deals.bid_due_date writer uses (migration 0132,
  // normalizeOptionalDealBidDueDate) and the one holdHorizonDateSql reads back with AT TIME ZONE 'UTC'.
  // A bare date literal would be resolved in the SESSION timezone and could land a day early.
  const nextValue = dateOnlyToUtcMidnightIso(nextDay);
  const updateResult = await client.query(
    `WITH existing AS (
       SELECT bid_due_date,
              bid_board_project_number,
              -- THE VALUE GUARD. Compared on the CALENDAR DAY, not the instant, and against an explicit
              -- date parameter ($3) rather than a cast of $2 (casting a timestamptz to date resolves in
              -- the SESSION timezone — the exact trap AT TIME ZONE 'UTC' exists to avoid).
              --
              -- Two reasons the day is the right unit. First, the day is the entire business value and the
              -- only thing holdHorizonDateSql reads, so a legacy row stored at 14:30 on the correct day
              -- needs no correction. Second, an instant comparison would rewrite that row and then emit a
              -- deal_history entry reading "2026-06-01 -> 2026-06-01", because the guard compared instants
              -- while the history renders days — a row that looks like a bug to whoever audits the first
              -- enabled run. Any write that does happen still normalizes the column to UTC midnight ($2).
              ((bid_due_date AT TIME ZONE 'UTC')::date IS DISTINCT FROM $3::date) AS value_changes,
              -- THE PROVENANCE GUARD, deliberately NOT the same guard as the value one.
              --
              -- A lead-backed legacy deal can already hold the right DAY while its lead says something
              -- else. The value guard skips it correctly — there is nothing to write — but if that also
              -- skipped the stamp, the deal could never earn the read override: every later sync carrying
              -- the same Board date would skip it again, forever, even though the Board plainly confirms
              -- the date. It IS Board-confirmed; it simply needed no correction. So: skip the VALUE write,
              -- still record the confirmation.
              (bid_due_date_from_bid_board_at IS NULL
                 OR bid_due_date_bid_board_project_number IS DISTINCT FROM bid_board_project_number)
                AS provenance_stale
         FROM ${schemaName}.deals
        WHERE id = $1
          -- Detached deals keep their own bid due date: the matcher already excludes them, but repeating
          -- the predicate at the write site keeps the invariant local (see buildBidBoardDealUpdateSql).
          -- The CTE returns no row, so the caller reads skippedNoChange and nothing is written.
          AND bid_board_detached_at IS NULL
        FOR UPDATE
     ), updated AS (
       UPDATE ${schemaName}.deals d
          -- The value moves only when the day actually differs; the stamps are (re-)written either way.
          SET bid_due_date = CASE WHEN existing.value_changes THEN $2::timestamptz ELSE d.bid_due_date END,
              -- PROVENANCE (migration 0225): WHEN the sync wrote or confirmed this date, and WHICH Bid
              -- Board project it did so for. The read resolver requires both before it will let the deal
              -- column outrank the source lead, so this write is what MAKES a deal eligible for the
              -- override — a coincidental day match never does. The project number is copied FROM the live
              -- column in this same statement, so the stamp and the identity it names cannot disagree.
              bid_due_date_from_bid_board_at = NOW(),
              bid_due_date_bid_board_project_number = d.bid_board_project_number,
              -- Untouched on a stamp-only pass: confirming provenance is internal bookkeeping, not a
              -- user-visible edit, so this row's updated_at must not move when nothing a human reads has.
              updated_at = CASE WHEN existing.value_changes THEN NOW() ELSE d.updated_at END
         FROM existing
        WHERE d.id = $1
          AND (existing.value_changes OR existing.provenance_stale)
        RETURNING existing.bid_due_date AS old_bid_due_date,
                  existing.value_changes AS value_changed,
                  d.bid_due_date AS new_bid_due_date
     )
     SELECT existing.bid_due_date AS current_bid_due_date,
            updated.old_bid_due_date,
            updated.value_changed,
            updated.new_bid_due_date
       FROM existing
       LEFT JOIN updated ON true`,
    [deal.id, nextValue, nextDay]
  );

  const rowResult = updateResult.rows[0];
  // THREE distinct outcomes below the value write, and they are MUTUALLY EXCLUSIVE so the counters sum.
  //
  //   value_changed === false -> the UPDATE fired as a STAMP-ONLY pass. A row that was genuinely written
  //                              is NOT a no-change row; counting it as both inflated skippedNoChange and
  //                              made the per-row outcomes stop reconciling against `matched`.
  //   value_changed == null   -> no `updated` row at all: either `existing` returned nothing (the deal was
  //                              detached mid-sync) or neither guard was true. Nothing happened.
  //
  // Either way the VALUE did not move, so there is no deal_history row and nothing for the operator's
  // changed-count to include.
  if (rowResult?.value_changed === false) {
    return {
      updated: false,
      skippedNoValue: false,
      skippedNoChange: false,
      provenanceStamped: true,
      warning: null,
    };
  }
  if (rowResult?.value_changed !== true) {
    return {
      updated: false,
      skippedNoValue: false,
      skippedNoChange: true,
      provenanceStamped: false,
      warning: null,
    };
  }

  // Recorded as calendar DAYS, not instants: the column's business value is date-only, and a
  // deal_history row a human reads should say "2026-09-01", not a timestamp whose timezone invites the
  // exact off-by-one this module is careful about everywhere else.
  const oldValue = bidDueDateToDateOnly(rowResult.old_bid_due_date ?? null);
  const newValue = bidDueDateToDateOnly(rowResult.new_bid_due_date) ?? nextDay;
  await client.query(
    `INSERT INTO ${schemaName}.deal_history
       (deal_id, field_name, old_value, new_value, changed_by, source, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      deal.id,
      "bid_due_date",
      oldValue,
      newValue,
      changedByUserId,
      BID_BOARD_DUE_DATE_SYNC_SOURCE,
      BID_BOARD_DUE_DATE_SYNC_REASON,
    ]
  );

  await logBidBoardActivity(client, schemaName, { ...deal, name: deal.name ?? row.name }, {
    bidDueDate: { from: oldValue, to: newValue },
  }, { source: BID_BOARD_DUE_DATE_SYNC_SOURCE, reason: BID_BOARD_DUE_DATE_SYNC_REASON });

  return {
    updated: true,
    skippedNoValue: false,
    skippedNoChange: false,
    provenanceStamped: false,
    warning: null,
  };
}

export async function writeStageIfSafe(
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
        appliedTerminalExit: false,
        skippedTerminal: false,
        warning: `Skipped Bid Board stage metadata refresh for deal ${deal.id}: stage changed during sync`,
      };
    }
    return {
      updated: false,
      skippedNoStageChange: true,
      appliedBackward: false,
      appliedTerminalExit: false,
      skippedTerminal: false,
      warning: null,
    };
  }

  // Bid Board is the AUTHORITATIVE source of truth for a bid-board-owned deal's stage. We mirror it
  // even OUT of a terminal Won/Lost stage (a terminal exit) and even backward (target display_order
  // < current) — both are APPLIED, not pinned, because the Bid Board, not the CRM, owns these deals.
  // We detect the direction so it is recorded on the stage-history row (is_backward_move) and
  // surfaced via the appliedBackward / appliedTerminalExit metrics + logs. The stage UPDATE below
  // stamps a fresh stage_entered_at on every move (the SLA clock resets exactly as for a forward
  // move) and keeps the terminal fields (won_closed_date / actual_close_date / lost_at) in lockstep
  // with the new stage — set on entry, cleared on exit — matching changeDealStage.
  const isTerminalExit = Boolean(deal.stage_is_terminal) || isTerminalWorkflowStage(deal.stage_slug, route);
  const currentOrder = stageOrder(deal.stage_display_order);
  const targetOrder = stageOrder(targetStage.display_order);
  const isBackwardMove = currentOrder != null && targetOrder != null && targetOrder < currentOrder;

  if (!changedByUserId) {
    return {
      updated: false,
      skippedNoStageChange: false,
      appliedBackward: false,
      appliedTerminalExit: false,
      skippedTerminal: false,
      warning: `Skipped Bid Board stage update for deal ${deal.id}: no active admin/director user available for audit history`,
    };
  }

  // Keep won_closed_date (migration 0141 Won-period basis) in lockstep with Won status, EXACTLY as
  // changeDealStage does: a present contract-signed date wins; otherwise the stage-driven won date —
  // which PRESERVES the existing value (including NULL) when moving between Won stages and stamps
  // today ONLY on a fresh entry to Won. Any non-Won target clears it (null). Never fabricate today
  // for an already-won deal (that would shift it into the current reporting period).
  const targetIsWon = isGenuineWonDealStageSlug(targetSlug, route);
  const alreadyWon = isGenuineWonDealStageSlug(deal.stage_slug, route);
  const nextWonClosedDate = targetIsWon
    ? resolveWonClosedDateWriteThrough({
        contractSignedDate: effectiveContractSignedDate(deal.contract_signed_date, deal.contract_signed_at),
        stageDrivenWonDate: alreadyWon ? toDateOnlyString(deal.won_closed_date) : new Date().toISOString().split("T")[0],
      })
    : null;

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
            won_closed_date = $9::date,
            -- Only-if-empty awarded_amount seed on a Win, mirroring awardedAmountSeedOnWin's
            -- "blank + positive bid" rule against the LIVE row: reads bid_estimate AS IT STANDS
            -- after writeEstimateIfNeeded ran earlier this sync cycle (so a deal that gets its
            -- estimate set AND wins in the same cycle still seeds), and only fills a NULL awarded
            -- amount so a present (e.g. director-confirmed) value is never overwritten. $12 is the
            -- targetIsWon flag, making this a no-op on non-Won writes.
            awarded_amount = CASE
              WHEN $12::boolean AND awarded_amount IS NULL AND bid_estimate IS NOT NULL AND bid_estimate > 0
              THEN bid_estimate
              ELSE awarded_amount
            END,
            actual_close_date = CASE WHEN $6::text = 'won' THEN COALESCE(actual_close_date, CURRENT_DATE) ELSE NULL END,
            lost_at = CASE WHEN $6::text = 'lost' THEN COALESCE(lost_at, NOW()) ELSE NULL END,
            bid_board_loss_outcome = CASE WHEN $6::text = 'lost' THEN COALESCE(bid_board_loss_outcome, $8::text) ELSE NULL END,
            -- Clear ALL stale loss details when the deal leaves Lost (parity with changeDealStage's
            -- "clear all terminal fields"); a reopened Lost deal must not keep its lost reason/notes.
            lost_reason_id = CASE WHEN $6::text = 'lost' THEN lost_reason_id ELSE NULL END,
            lost_notes = CASE WHEN $6::text = 'lost' THEN lost_notes ELSE NULL END,
            lost_competitor = CASE WHEN $6::text = 'lost' THEN lost_competitor ELSE NULL END,
            updated_at = NOW()
      WHERE id = $10
        AND stage_id = $11
        -- THE stage dragger: this is the write that would undo "Move back to Opportunity" on the very
        -- next export (backward and terminal-exit moves are APPLIED here, not pinned). Repeated at the
        -- write site so the feature cannot be silently defeated by a future caller.
        AND bid_board_detached_at IS NULL
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
      nextWonClosedDate,
      deal.id,
      deal.stage_id,
      targetIsWon,
    ]
  );

  if ((updateResult.rowCount ?? 0) === 0) {
    return {
      updated: false,
      skippedNoStageChange: false,
      appliedBackward: false,
      appliedTerminalExit: false,
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

  return {
    updated: true,
    skippedNoStageChange: false,
    appliedBackward: isBackwardMove,
    appliedTerminalExit: isTerminalExit,
    skippedTerminal: false,
    warning: null,
  };
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
  // Ambiguous-estimator names already reported this run. The collision is a CONFIG fact about two user
  // records, not a fact about the deal in hand — one shared name across fifty rows is one problem with
  // one fix, and fifty identical lines would bury the rest of the run's warnings.
  const ambiguousEstimatorsWarned = new Set<string>();
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
    appliedTerminalExit: 0,
    skippedTerminal: 0,
    skippedNoStageChange: 0,
    skippedDetached: 0,
    estimateUpdated: 0,
    estimateUpdatedHigher: 0,
    estimateUpdatedLower: 0,
    estimateSkippedNoValue: 0,
    estimateSkippedNoChange: 0,
    estimateSkippedTerminal: 0,
    estimateWarnings: 0,
    bidDueDateUpdated: 0,
    bidDueDateSkippedNoValue: 0,
    bidDueDateSkippedNoChange: 0,
    bidDueDateProvenanceStamped: 0,
    bidDueDateSkippedNoAttributor: 0,
    bidDueDateSkippedDuplicateProjectNumber: 0,
  };

  // Resolved ONCE per run, not per row: a flag flipped mid-run would otherwise write the date on some of
  // an export's rows and not others, which is the hardest kind of partial application to explain later.
  const bidDueDateReadbackEnabled = isBidBoardDueDateReadbackEnabled();

  const seenProjectNumbers = new Set<string>();
  const duplicateProjectNumbers = new Set<string>();
  // Distinct parsed Due Date DAYS seen per canonical Project #. A payload can legitimately repeat a
  // project (Procore appends "(N)" to duplicated names), but when the repeats DISAGREE about the due date
  // there is no way to tell which one the board means — and without this the row loop would write both in
  // sequence, leaving EXPORT ORDER to decide which date lands on the deal. Silently.
  //
  // BUILT ONLY FROM ROWS THE LOOP WILL ACTUALLY PROCESS. A row the ingest discards contributes no opinion,
  // so it must not be able to veto one: a `Status: Templates` row sharing a canonical Project # would
  // otherwise refuse the real row's write AND (since the mirror now moves with it) withhold its mirror,
  // leaving the signal false for as long as that row sits on the board — and naming a project with no
  // genuine conflict in the warning. The row-level guards below are exactly the ones the loop applies
  // before it reaches the write-through; the remaining ones (detached / no-match / multi-match) are
  // per-DEAL and unknowable here, but they skip the row entirely rather than writing a second opinion.
  const dueDateDaysByProjectNumber = new Map<string, Set<string>>();
  for (const row of rows) {
    const projectNumber = normalizeBidBoardProjectNumber(row["Project #"]);
    if (!projectNumber) {
      metrics.nullProjectNumbers++;
      continue;
    }
    // The duplicate-Project# WARNING is deliberately still counted across every row: two board rows
    // sharing a number is a board-hygiene problem worth reporting whether or not the ingest processes
    // both. Only the due-date CONFLICT set narrows below.
    if (seenProjectNumbers.has(projectNumber)) duplicateProjectNumbers.add(projectNumber);
    seenProjectNumbers.add(projectNumber);

    // Normalized through the SAME function the row loop uses, rather than re-deriving the fields here —
    // a second, similar-looking derivation is how the two drift apart.
    const scanRow = normalizeBidBoardRow(row);
    if (!scanRow.name) continue;
    if (isTemplatesStatus(scanRow.bidBoardStatus)) continue;

    // Only PARSEABLE dates count toward a conflict: a blank cell never clears (see
    // writeBidDueDateIfNeeded), so "one row dated, one row blank" is not a disagreement — the dated row
    // is simply the only one with an opinion.
    const parsedDay = scanRow.bidBoardDueDate;
    if (parsedDay) {
      const days = dueDateDaysByProjectNumber.get(projectNumber) ?? new Set<string>();
      days.add(parsedDay);
      dueDateDaysByProjectNumber.set(projectNumber, days);
    }
  }
  metrics.duplicateProjectNumbers = duplicateProjectNumbers.size;
  for (const projectNumber of duplicateProjectNumbers) {
    warnings.push(`Incoming payload contains duplicate Project #: ${projectNumber}`);
  }
  const conflictingDueDateProjectNumbers = new Set(
    [...dueDateDaysByProjectNumber].filter(([, days]) => days.size > 1).map(([projectNumber]) => projectNumber)
  );

  const client = await pool.connect();
  let releaseErr: unknown;
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

    const updateSql = buildBidBoardDealUpdateSql(schemaName, {
      preserveBlankDueDate: bidDueDateReadbackEnabled,
    });
    const changedByUserId = await findSystemChangedByUserId(client, officeSlug);
    const activeUserIds = await loadActiveUserIds(client);
    // Loaded once per sync run, not per deal: a batch can carry hundreds of rows and this is the same
    // handful of flagged users for all of them.
    const estimatorDirectory = await loadEstimatorDirectory(client);

    for (const rawRow of rows) {
      const normalized = normalizeBidBoardRow(rawRow);
      if (!normalized.name) {
        metrics.noMatch++;
        warnings.push("Skipped Bid Board row without Name");
        continue;
      }

      const dueDate = parseBidBoardDueDate(rawRow["Due Date"], normalized.name, {
        preserveBlankDueDate: bidDueDateReadbackEnabled,
      });
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

      // Tier-by-tier across attached AND detached deals (see resolveDealMatches). A detached deal is
      // deliberately invisible to the matcher, but it must be reported as a deliberate SKIP rather than
      // as "no CRM deal matched": folding it into noMatch would (a) lie to the operator, (b) flip every
      // run from here on to 'completed_with_unmatched', and (c) fill unmatched_project_numbers with rows
      // nobody should act on. The warning it gets instead is the actionable one — the project is still
      // sitting on the Bid Board and needs deleting by hand, which the CRM cannot do.
      const { matches, detached: detachedMatches } = await resolveDealMatches(
        client,
        schemaName,
        normalized
      );
      if (detachedMatches.length > 0) {
        metrics.skippedDetached++;
        // toDateOnlyString, not String(...).slice(0,10) — node-pg hands back a Date for timestamptz,
        // whose default string form is "Mon Jul 20 2026 …", so a naive slice prints a weekday.
        const detachedAt = toDateOnlyString(detachedMatches[0].bid_board_detached_at);
        warnings.push(
          `Skipped Bid Board Project # ${normalized.bidBoardProjectNumber} (${normalized.name}): CRM deal ${detachedMatches[0].id} was moved back to Opportunity${detachedAt ? ` on ${detachedAt}` : ""} and is detached from Bid Board sync. Delete this project from the Bid Board.`
        );
        continue;
      }
      if (matches.length === 0) {
        metrics.noMatch++;
        if (unmatchedProjectNumbers.length < MAX_UNMATCHED_PROJECT_NUMBERS) {
          unmatchedProjectNumbers.push(normalized.bidBoardProjectNumber);
        }
        // Surface EVERY unmatched row (not only strictly-structured numbers) so a deal
        // that silently failed to receive its Bid Board stage is visible to the operator.
        warnings.push(
          `No CRM deal matched Bid Board Project # ${normalized.bidBoardProjectNumber} (${normalized.name})`
        );
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
      // Resolve the estimator name to a user id, but only WRITE it if it is an existing active
      // user — a misconfigured map id (valid UUID shape but no such user) would otherwise
      // FK-violate deals.estimator_user_id and abort the whole batch. Bad id -> null + warning.
      // When the map is unconfigured (unset/empty/malformed) PRESERVE the existing
      // estimator_user_id so a deploy gap can't wipe backfilled ids. When configured, resolve
      // the current estimator name and only write an EXISTING active user id (a bad/inactive
      // map id -> null + warning, never an FK-abort).
      // Snapshot the deal's pre-update estimator. Used to route the empties-only warning below and as
      // the audit mirror's `from`; the value actually WRITTEN comes from the UPDATE's RETURNING clause
      // (the live row), never from this snapshot (Codex #741 follow-up).
      const existingEstimatorUserId = matches[0].estimator_user_id ?? null;
      let estimatorUserId: string | null;
      if (!isEstimatorResolutionConfigured(estimatorDirectory)) {
        estimatorUserId = matches[0].estimator_user_id ?? null;
      } else {
        const resolvedEstimatorUserId = resolveEstimatorUserId(
          normalized.bidBoardEstimator,
          estimatorDirectory
        );
        estimatorUserId =
          resolvedEstimatorUserId && activeUserIds.has(resolvedEstimatorUserId)
            ? resolvedEstimatorUserId
            : null;
        // A name two flagged users share resolves to nothing by design (buildEstimatorDirectory drops
        // it rather than guessing). Say so: otherwise the deal reads "Missing estimator" forever and
        // looks identical to a name nobody has flagged, which is a different and differently-fixed
        // problem — this one is fixed by renaming a user or adding a curated map alias.
        if (!resolvedEstimatorUserId) {
          const key = normalizeEstimatorKey(normalized.bidBoardEstimator);
          if (key && estimatorDirectory.ambiguous.has(key) && !ambiguousEstimatorsWarned.has(key)) {
            ambiguousEstimatorsWarned.add(key);
            warnings.push(
              `Bid Board estimator "${normalized.bidBoardEstimator}" matches more than one active user flagged "estimates jobs" — estimator_user_id left null rather than guessing between them (add a BID_BOARD_ESTIMATOR_USER_MAP entry to disambiguate)`
            );
          }
        }
        if (resolvedEstimatorUserId && !estimatorUserId) {
          // The map resolved to an inactive user, so the incoming id will not be written. Whether the
          // field ends up null depends on the empties-only COALESCE: when the deal already has an
          // estimator it is PRESERVED (report the incoming id as ignored), otherwise the write lands
          // null (report it as left null). The prior single "left null" message lied for every
          // manually-set deal (Codex #741).
          warnings.push(
            existingEstimatorUserId
              ? `Bid Board estimator "${normalized.bidBoardEstimator}" maps to ${resolvedEstimatorUserId}, which is not an active CRM user — incoming id ignored (empties-only; existing estimator ${existingEstimatorUserId} preserved) (check BID_BOARD_ESTIMATOR_USER_MAP)`
              : `Bid Board estimator "${normalized.bidBoardEstimator}" maps to ${resolvedEstimatorUserId}, which is not an active CRM user — estimator_user_id left null (check BID_BOARD_ESTIMATOR_USER_MAP)`
          );
        }
      }
      // Invariant guard (mirrors the manual estimator/source conflict rejection in setDealEstimator):
      // never let the empties-only fill land the SAME user as the deal's sales source. estimator == source
      // makes calculateCommissionForDeal skip the additive sales_source cut and mint an estimator cut for
      // that rep instead — silently re-attributing the sourced-book commission + floor credit. Drop the
      // incoming id (leave estimator null) so the sales-source attribution wins. Only bites on a genuine
      // fill (existing estimator null); when one is already set the COALESCE preserves it and this incoming
      // id is dropped anyway, so we skip the noisy warning in that case.
      // NOTE: this JS check reads the findDealMatches SNAPSHOT — it is the observability/warning layer. The
      // AUTHORITATIVE guard is the SQL NULLIF($16, sales_source_user_id) in buildBidBoardDealUpdateSql,
      // which evaluates against the LIVE locked row and so also catches a source set between this SELECT
      // and the UPDATE's row lock (TOCTOU).
      const dealSalesSourceUserId = (matches[0].sales_source_user_id ?? null) as string | null;
      if (estimatorUserId && estimatorUserId === dealSalesSourceUserId) {
        if (!existingEstimatorUserId) {
          warnings.push(
            `Bid Board estimator "${normalized.bidBoardEstimator}" maps to ${estimatorUserId}, which is already the deal's sales source — estimator_user_id left null to preserve the sales-source commission attribution (deal ${matches[0].id})`
          );
        }
        estimatorUserId = null;
      }
      // Empties-only guard (SET estimator_user_id = COALESCE(estimator_user_id, $16) above): when the
      // deal already has an estimator, the DB keeps it and this resolved value is dropped on the floor.
      // Log the preserved vs ignored ids so the decision is observable (Codex #741 P2).
      if (existingEstimatorUserId && estimatorUserId !== existingEstimatorUserId) {
        console.warn(
          `[BidBoardSync] Preserved existing estimator_user_id ${existingEstimatorUserId} for deal ${matches[0].id}; ignored incoming ${estimatorUserId ?? "null"} (empties-only sync)`
        );
      }
      // ★ THE MIRROR AND THE VALUE ADVANCE TOGETHER, OR NEITHER DOES.
      //
      // `bid_board_due_date` is not decoration — it is half the read-back's signal, which fires only while
      // it EQUALS the stamped `bid_due_date`. This mirror UPDATE runs earlier and unconditionally, so any
      // later guard that declines the value write leaves the two columns disagreeing and SILENTLY switches
      // the override off for a deal that had legitimately earned it. The deal keeps its correct date and
      // loses the provenance that made it authoritative — worse than either writing or not writing.
      //
      // Two guards have that shape, and this covers both rather than the one that surfaced it:
      //   - a canonically-duplicated Project # whose rows DISAGREE about the Due Date (below);
      //   - no admin/director to attribute the deal_history row to, which refuses the write for the WHOLE
      //     run, so without this every matched deal in that run would lose its signal at once.
      //
      // Withholding the mirror is the right half to give up. It is never published to a user, so a stale
      // mirror costs nothing visible, whereas advancing it destroys provenance we legitimately earned on
      // an earlier, unambiguous sync — and nothing about today's ambiguity invalidates yesterday's write.
      //
      // ⚠️ SCOPE, precisely — this withholds `bid_board_due_date` ONLY, not "everything the signal reads".
      // An earlier draft of this comment said a declining sync "moves nothing", which is not true: the
      // signal ALSO requires bid_due_date_bid_board_project_number == bid_board_project_number, and the
      // mirror UPDATE advances bid_board_project_number ($14) unconditionally. So a declined run that ALSO
      // sees a changed Project # does revoke the override, until the next run that can write re-earns the
      // stamp for the new number.
      //
      // That is deliberate, not an oversight. bid_board_project_number is not merely a signal input — it
      // is the matcher's own tier-2 identity and carries a canonical UNIQUE index, so freezing it would
      // make the CRM's record of which board project this deal is stale and change how LATER runs match.
      // And a genuine project change SHOULD revoke: that is exactly the retired-project rule the identity
      // half exists for. The failure mode is bounded and self-healing — one cycle, once an attributor
      // exists and the duplicate is resolved — and it fails toward the legacy precedence, which is the
      // safe direction.
      //
      // Known sharp edge, deliberately left as-is: the resolver compares those two project numbers as RAW
      // strings, while the matcher decides project identity CANONICALLY. So a purely cosmetic Project #
      // edit on the board (case, spacing, a Unicode dash) also revokes the override until the next
      // successful write re-stamps it. Conservative in the safe direction, self-healing, and changing the
      // comparison would alter identity semantics — which deserves its own review, not a last-round edit.
      //
      // Mechanically this is just `$11 = NULL`, which the flag-on SET reads through
      // COALESCE($11::date, bid_board_due_date) as "leave it alone". Flag OFF is untouched: the SET is a
      // plain $11 there and this whole notion does not exist, so main parity is preserved by construction.
      const canonicalProjectNumber = normalizeBidBoardProjectNumber(normalized.bidBoardProjectNumber);
      const dueDateConflicted =
        canonicalProjectNumber != null && conflictingDueDateProjectNumbers.has(canonicalProjectNumber);
      const dueDateCanAdvance = changedByUserId != null && !dueDateConflicted;
      const mirrorRow: NormalizedBidBoardRow =
        bidDueDateReadbackEnabled && !dueDateCanAdvance
          ? { ...normalized, bidBoardDueDate: null }
          : normalized;

      let updateResult;
      await client.query(`SAVEPOINT ${BID_BOARD_MIRROR_UPDATE_SAVEPOINT}`);
      try {
        updateResult = await client.query(
          updateSql,
          updateParams(matches[0].id, mirrorRow, bidBoardLastUpdatedAt, estimatorUserId)
        );
        await client.query(`RELEASE SAVEPOINT ${BID_BOARD_MIRROR_UPDATE_SAVEPOINT}`);
      } catch (err) {
        await client.query(`ROLLBACK TO SAVEPOINT ${BID_BOARD_MIRROR_UPDATE_SAVEPOINT}`);
        await client.query(`RELEASE SAVEPOINT ${BID_BOARD_MIRROR_UPDATE_SAVEPOINT}`);

        if (isCanonicalBidBoardProjectNumberUniqueViolation(err)) {
          warnings.push(
            `Skipped Bid Board row ${normalized.bidBoardProjectNumber}: duplicate canonical Bid Board project number would collide while updating deal ${matches[0].id}; remaining export rows will continue`
          );
          continue;
        }
        throw err;
      }
      if ((updateResult.rowCount ?? 0) > 0) {
        metrics.updated++;
        const updateDeal = updateResult.rows?.[0] ?? matches[0];
        // Audit the estimator the UPDATE actually wrote (RETURNING estimator_user_id), not the
        // pre-update snapshot. The COALESCE evaluates against the LIVE row, so a director editing the
        // estimator between findDealMatches and this UPDATE would make a snapshot-derived value wrong;
        // the RETURNING value is the source of truth for the mirror's `to` (Codex #741 TOCTOU).
        const writtenEstimatorUserId = (updateDeal.estimator_user_id ?? null) as string | null;
        await logBidBoardActivity(
          client,
          schemaName,
          updateDeal,
          // mirrorRow, not `normalized`: when the due date was withheld above, the audit trail must not
          // claim a mirror move that did not happen.
          buildBidBoardMirrorFieldChanges(matches[0], mirrorRow, bidBoardLastUpdatedAt, writtenEstimatorUserId, bidDueDateReadbackEnabled),
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

      // Bid Board Due Date -> deals.bid_due_date, in the SAME position as the estimate writeback: after
      // the match / detach / template checks, so a detached deal is never touched. Flag off => the
      // function is not called at all, so the run issues no extra query and every counter stays 0.
      if (bidDueDateReadbackEnabled) {
        // AMBIGUOUS SOURCE. Two rows in this payload carry the same canonical Project # and DIFFERENT
        // parsed Due Dates, so "the Bid Board's date" is not a single value. Writing both in sequence
        // would let the export's row order pick the winner — and this column is the auto-park horizon, so
        // that silently decides the deal's reported value too. Refuse instead, and say so: an operator can
        // fix the duplicate on the board, which is the only real remedy.
        // Scoped to THIS write only — deliberately not a `continue`, which would also skip the stage
        // writeback below and silently widen an ambiguous due date into an ambiguous stage. The mirror was
        // already withheld for this row above, so the two columns stay in agreement.
        if (dueDateConflicted) {
          metrics.bidDueDateSkippedDuplicateProjectNumber++;
          warnings.push(
            `Skipped Bid Board bid due date update for deal ${matches[0].id}: Project # ${normalized.bidBoardProjectNumber} appears more than once in this export with different Due Dates, so the correct date is ambiguous`
          );
        } else {
          const bidDueDateResult = await writeBidDueDateIfNeeded(
            client,
            schemaName,
            matches[0],
            normalized,
            changedByUserId
          );
          // Exactly one of these fires per matched row — see BidDueDateWritebackResult.
          if (bidDueDateResult.updated) metrics.bidDueDateUpdated++;
          if (bidDueDateResult.provenanceStamped) metrics.bidDueDateProvenanceStamped++;
          if (bidDueDateResult.skippedNoValue) metrics.bidDueDateSkippedNoValue++;
          if (bidDueDateResult.skippedNoChange) metrics.bidDueDateSkippedNoChange++;
          if (bidDueDateResult.skippedNoAttributor) metrics.bidDueDateSkippedNoAttributor++;
          if (bidDueDateResult.warning) warnings.push(bidDueDateResult.warning);
        }
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
      if (stageResult.appliedTerminalExit) {
        metrics.appliedTerminalExit++;
        console.info(
          `[BidBoardSync] Applied terminal-exit stage move for deal ${matches[0].id}: ${matches[0].stage_slug} -> ${targetStage.slug} (Bid Board is source of truth; won_closed_date kept in lockstep)`
        );
      }
      if (stageResult.skippedTerminal) metrics.skippedTerminal++;
      if (stageResult.warning) warnings.push(stageResult.warning);
    }

    metrics.warnings = warnings.length;
    // The 0222 counter column is written ONLY when the feature is on, and is appended at the END of the
    // SET list / parameter array when it is.
    //
    // This is not tidiness — it is the difference between a disabled feature and a broken office.
    // Migrations run on API deploy and the WORKER does not run them (it is the process that calls this),
    // so a worker running ahead of the API against a schema that has not yet received 0222 would fail this
    // statement on an unknown column — INSIDE the run's BEGIN, rolling back that office's ENTIRE sync
    // (mirror, estimate and stage writebacks included) with the feature switched off. Referencing the
    // column only when the flag is on means the feature cannot break the sync before it is turned on.
    //
    // Appending rather than inserting also keeps the existing positional params stable: the string-mock
    // suites assert $6 = status and $24 = estimate_skipped_terminal_count.
    const bidDueDateRunColumnSql = bidDueDateReadbackEnabled
      ? `,
              bid_due_date_updated_count = $26`
      : "";
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
              estimate_skipped_terminal_count = $24,
              skipped_detached_count = $25${bidDueDateRunColumnSql}
        WHERE id = $1`,
      [
        runId,
        metrics.updated,
        metrics.noMatch,
        metrics.multiMatch,
        warnings.length,
        errors.length > 0
          ? "failed"
          : metrics.noMatch > 0
            ? "completed_with_unmatched"
            : "success",
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
        metrics.skippedDetached,
        ...(bidDueDateReadbackEnabled ? [metrics.bidDueDateUpdated] : []),
      ]
    );
    await client.query("COMMIT");

    for (const warning of warnings) {
      console.warn(`[BidBoardSync] ${warning}`);
    }

    return { runId, metrics, warnings };
  } catch (err) {
    if (isBrokenConnectionError(err)) {
      // Dead socket — skip ROLLBACK (it can't succeed and would wait another query_timeout); destroy.
      releaseErr = err;
    } else {
      let rollbackErr: unknown;
      await client.query("ROLLBACK").catch((e) => { rollbackErr = e; });
      releaseErr = rollbackErr ?? err;
    }
    throw err;
  } finally {
    releasePooledClient(client, releaseErr);
  }
}
