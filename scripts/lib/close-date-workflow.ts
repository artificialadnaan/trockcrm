/**
 * Shared core for the per-rep expected-close-date export / re-import workflow.
 *
 * This module holds the PURE, side-effect-free logic (date parsing, row
 * classification, rep grouping, SQL builders) plus thin database helpers that
 * accept an injected {@link Queryable}. The two CLI entrypoints
 * (`scripts/close-date-export.ts`, `scripts/close-date-reimport.ts`) own all of
 * the process concerns: arg parsing, the pg connection, file IO and reporting.
 *
 * Keeping the logic pure + the DB access behind a narrow interface is what lets
 * the gated `*.runtime.test.ts` suite exercise everything against PGlite.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal query surface satisfied by both `pg.Client` and a PGlite instance. */
export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/** One open deal that is missing an expected close date. */
export type MissingCloseDateDeal = {
  tenantSchema: string;
  dealId: string;
  dealNumber: string;
  dealName: string;
  companyName: string | null;
  stageName: string | null;
  estimatedValue: string | null;
  assignedRepId: string | null;
  repName: string;
};

/** A rep and the deals that will go into their workbook. */
export type RepGroup = {
  repName: string;
  assignedRepId: string | null;
  fileSlug: string;
  deals: MissingCloseDateDeal[];
};

/** Result of parsing a rep-filled "Expected Close Date" cell. */
export type ParsedDate =
  | { status: "ok"; value: string }
  | { status: "blank" }
  | { status: "invalid"; reason: string };

/** Per-row outcome for the re-import. */
export type RowOutcome =
  | "WRITTEN"
  | "OVERWRITTEN"
  | "NOOP"
  | "CONFLICT"
  | "SKIPPED_BLANK"
  | "INVALID_DATE"
  | "INVALID_KEY"
  | "UNMATCHED"
  | "ERROR";

const MIN_YEAR = 2000;
const MAX_YEAR = 2100;
const EXCEL_EPOCH_UTC_MS = Date.UTC(1899, 11, 30); // Excel day 0 == 1899-12-30

// ---------------------------------------------------------------------------
// Date parsing (pure)
// ---------------------------------------------------------------------------

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Build an ok/invalid result from calendar parts, rejecting impossible/out-of-range dates. */
function fromYmd(year: number, month: number, day: number): ParsedDate {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return { status: "invalid", reason: "not a calendar date" };
  }
  if (year < MIN_YEAR || year > MAX_YEAR) {
    return { status: "invalid", reason: `year out of range (${MIN_YEAR}-${MAX_YEAR})` };
  }
  // Round-trip through UTC to reject non-existent days (e.g. Feb 30 normalises away).
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (
    dt.getUTCFullYear() !== year ||
    dt.getUTCMonth() !== month - 1 ||
    dt.getUTCDate() !== day
  ) {
    return { status: "invalid", reason: "impossible calendar date" };
  }
  return { status: "ok", value: `${year}-${pad2(month)}-${pad2(day)}` };
}

/**
 * Parse a rep-filled cell into a normalised `YYYY-MM-DD` string.
 * Accepts: JS Date (exceljs date cells), Excel serial number, ISO `YYYY-MM-DD`,
 * `YYYY/M/D`, and US `M/D/YYYY`. Empty/whitespace is BLANK (no write intended);
 * anything unparseable / impossible / out of range is INVALID.
 */
export function parseExpectedCloseDate(cell: unknown): ParsedDate {
  if (cell === null || cell === undefined) return { status: "blank" };

  if (cell instanceof Date) {
    if (Number.isNaN(cell.getTime())) return { status: "invalid", reason: "invalid Date" };
    return fromYmd(cell.getUTCFullYear(), cell.getUTCMonth() + 1, cell.getUTCDate());
  }

  if (typeof cell === "number") {
    if (!Number.isFinite(cell)) return { status: "invalid", reason: "non-finite number" };
    // Truncate (not round) so a serial carrying a time fraction maps to its calendar day.
    const ms = EXCEL_EPOCH_UTC_MS + Math.floor(cell) * 86_400_000;
    const dt = new Date(ms);
    return fromYmd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
  }

  if (typeof cell === "string") {
    const s = cell.trim();
    if (s === "") return { status: "blank" };

    // ISO-ish, 4-digit year first (YYYY-MM-DD or YYYY/M/D); both separators must match.
    let m = /^(\d{4})([-/])(\d{1,2})\2(\d{1,2})$/.exec(s);
    if (m) return fromYmd(Number(m[1]), Number(m[3]), Number(m[4]));

    // US, month first, with a 2- or 4-digit year (M/D/YYYY, M-D-YY); separators must match.
    // NOTE: string US dates assume a US locale (M before D). Excel date-formatted cells
    // deliver a serial/Date (parsed above), so this string path is the fallback.
    m = /^(\d{1,2})([-/])(\d{1,2})\2(\d{2}|\d{4})$/.exec(s);
    if (m) {
      const rawYear = Number(m[4]);
      const year = m[4].length === 2 ? 2000 + rawYear : rawYear;
      return fromYmd(year, Number(m[1]), Number(m[3]));
    }

    return { status: "invalid", reason: "unrecognised date format" };
  }

  return { status: "invalid", reason: `unsupported cell type (${typeof cell})` };
}

// ---------------------------------------------------------------------------
// Row classification (pure) — safe default: never clobber, flag conflicts
// ---------------------------------------------------------------------------

export function classifyImportRow(input: {
  parsed: ParsedDate;
  keyValid: boolean;
  found: boolean;
  existing: string | null;
  overwriteExisting: boolean;
}): { outcome: RowOutcome; writeValue: string | null } {
  const { parsed, keyValid, found, existing, overwriteExisting } = input;

  // No value filled in -> nothing to do, regardless of key/match state.
  if (parsed.status === "blank") return { outcome: "SKIPPED_BLANK", writeValue: null };
  // A filled-but-bad value is surfaced so the rep can fix it.
  if (parsed.status === "invalid") return { outcome: "INVALID_DATE", writeValue: null };
  // Locked key columns should be intact; a bad key means tampering/corruption.
  if (!keyValid) return { outcome: "INVALID_KEY", writeValue: null };
  if (!found) return { outcome: "UNMATCHED", writeValue: null };

  if (existing === null) return { outcome: "WRITTEN", writeValue: parsed.value };
  if (existing === parsed.value) return { outcome: "NOOP", writeValue: null };
  // existing differs from the sheet value -> never silently clobber.
  if (overwriteExisting) return { outcome: "OVERWRITTEN", writeValue: parsed.value };
  return { outcome: "CONFLICT", writeValue: null };
}

// ---------------------------------------------------------------------------
// Rep grouping (pure)
// ---------------------------------------------------------------------------

const UNASSIGNED_KEY = "__unassigned__";

/** Filesystem-safe slug for a rep display name (mirrors client report-export.ts). */
export function repFileSlug(name: string): string {
  const slug = (name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "unassigned";
}

/**
 * Group deals into one bucket per rep (NULL rep -> a single "Unassigned"
 * bucket). Groups are sorted by rep name; deals within a group by deal number.
 * File slugs collide-proof: distinct reps sharing a display name get an id
 * suffix so their workbooks never overwrite each other.
 */
export function groupDealsByRep(deals: MissingCloseDateDeal[]): RepGroup[] {
  const byRep = new Map<string, RepGroup>();
  for (const deal of deals) {
    const key = deal.assignedRepId ?? UNASSIGNED_KEY;
    let group = byRep.get(key);
    if (!group) {
      group = {
        repName: deal.assignedRepId ? deal.repName : "Unassigned",
        assignedRepId: deal.assignedRepId,
        fileSlug: "",
        deals: [],
      };
      byRep.set(key, group);
    }
    group.deals.push(deal);
  }

  const groups = [...byRep.values()];
  for (const group of groups) {
    group.deals.sort((a, b) => a.dealNumber.localeCompare(b.dealNumber) || a.dealId.localeCompare(b.dealId));
  }
  groups.sort((a, b) => a.repName.localeCompare(b.repName));

  // Assign slugs, disambiguating collisions across distinct reps.
  const byBaseSlug = new Map<string, RepGroup[]>();
  for (const group of groups) {
    const base = repFileSlug(group.repName);
    group.fileSlug = base;
    const bucket = byBaseSlug.get(base);
    if (bucket) bucket.push(group);
    else byBaseSlug.set(base, [group]);
  }
  for (const [base, collided] of byBaseSlug) {
    if (collided.length <= 1) continue;
    for (const group of collided) {
      const suffix = (group.assignedRepId ?? "unassigned").slice(0, 8);
      group.fileSlug = `${base}-${suffix}`;
    }
  }

  return groups;
}

// ---------------------------------------------------------------------------
// Database access (injected Queryable)
// ---------------------------------------------------------------------------

/** Validate + double-quote a SQL identifier (schema name). */
export function quoteIdent(identifier: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(identifier)) {
    throw new Error(`Invalid identifier: ${identifier}`);
  }
  return `"${identifier.replace(/"/g, '""')}"`;
}

/** Every `office_*` schema that actually has a `deals` table. */
export async function discoverDealTenants(client: Queryable): Promise<string[]> {
  const { rows } = await client.query(
    `SELECT n.nspname AS schema_name
       FROM pg_namespace n
      WHERE n.nspname LIKE 'office\\_%' ESCAPE '\\'
        AND to_regclass(format('%I.deals', n.nspname)) IS NOT NULL
      ORDER BY n.nspname ASC`,
  );
  return rows.map((r) => String(r.schema_name));
}

/**
 * SELECT for one tenant of the open, rep-actionable deals that still need an
 * expected close date. Scope is deliberately narrow so reps only ever see deals
 * a forecast date makes sense for:
 *   - expected_close_date IS NULL  (the whole point)
 *   - is_active = true             (not archived / closed out)
 *   - is_test_data = false         (never export seeded test deals)
 *   - is_read_only_mirror = false  (Bid-Board mirrors aren't rep-owned in the CRM)
 *   - stage is not terminal        (Won/Lost don't need a forecast date)
 */
export function buildMissingCloseDateSql(schema: string): string {
  const s = quoteIdent(schema);
  // Join the rep only when ACTIVE: a deal owned by a deactivated rep (or a stale
  // assigned_rep_id with no matching user) has no one to fill its file, so it is
  // routed to the single Unassigned bucket (key nulled) rather than an orphan file.
  return `
    SELECT
      d.id::text                              AS "dealId",
      d.deal_number                           AS "dealNumber",
      d.name                                  AS "dealName",
      c.name                                  AS "companyName",
      psc.name                                AS "stageName",
      COALESCE(d.awarded_amount, d.bid_estimate, d.dd_estimate, d.forecast_revenue)::text AS "estimatedValue",
      CASE WHEN u.id IS NULL THEN NULL ELSE d.assigned_rep_id::text END AS "assignedRepId",
      COALESCE(u.display_name, 'Unassigned')  AS "repName"
    FROM ${s}.deals d
    LEFT JOIN public.users u ON u.id = d.assigned_rep_id AND u.is_active = true
    LEFT JOIN ${s}.companies c ON c.id = d.company_id
    LEFT JOIN public.pipeline_stage_config psc ON psc.id = d.stage_id
    WHERE d.expected_close_date IS NULL
      AND d.is_active = true
      AND d.is_test_data = false
      AND d.is_read_only_mirror = false
      AND COALESCE(psc.is_terminal, false) = false
    ORDER BY d.deal_number ASC, d.id ASC`;
}

/** Fetch + normalise the missing-close-date deals across all (or the given) tenants. */
export async function fetchMissingCloseDateDeals(
  client: Queryable,
  schemas?: string[],
): Promise<MissingCloseDateDeal[]> {
  const tenants = schemas ?? (await discoverDealTenants(client));
  const out: MissingCloseDateDeal[] = [];
  for (const schema of tenants) {
    const { rows } = await client.query(buildMissingCloseDateSql(schema));
    for (const row of rows) {
      out.push({
        tenantSchema: schema,
        dealId: String(row.dealId),
        dealNumber: String(row.dealNumber),
        dealName: String(row.dealName),
        companyName: row.companyName == null ? null : String(row.companyName),
        stageName: row.stageName == null ? null : String(row.stageName),
        estimatedValue: row.estimatedValue == null ? null : String(row.estimatedValue),
        assignedRepId: row.assignedRepId == null ? null : String(row.assignedRepId),
        repName: String(row.repName),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Re-import
// ---------------------------------------------------------------------------

export type ReimportMode = "dry-run" | "commit";

/** One parsed row from a filled workbook, ready to apply. */
export type ImportRowInput = {
  tenantSchema: string;
  dealId: string;
  rawDate: unknown;
  rowNumber?: number;
  dealNumber?: string;
  repName?: string;
};

export type ImportRowResult = ImportRowInput & {
  outcome: RowOutcome;
  value: string | null;
  existing: string | null;
  message?: string;
};

export type ReimportCounts = Record<RowOutcome, number> & { total: number };

export type ReimportReport = {
  mode: ReimportMode;
  overwriteExisting: boolean;
  results: ImportRowResult[];
  counts: ReimportCounts;
};

const ROW_OUTCOMES: RowOutcome[] = [
  "WRITTEN",
  "OVERWRITTEN",
  "NOOP",
  "CONFLICT",
  "SKIPPED_BLANK",
  "INVALID_DATE",
  "INVALID_KEY",
  "UNMATCHED",
  "ERROR",
];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function emptyCounts(): ReimportCounts {
  const counts = { total: 0 } as ReimportCounts;
  for (const outcome of ROW_OUTCOMES) counts[outcome] = 0;
  return counts;
}

/** Look up a deal's current expected close date (normalised to YYYY-MM-DD). */
export async function fetchDealExistingCloseDate(
  client: Queryable,
  schema: string,
  dealId: string,
): Promise<{ found: boolean; existing: string | null }> {
  const { rows } = await client.query(
    `SELECT to_char(expected_close_date, 'YYYY-MM-DD') AS d FROM ${quoteIdent(schema)}.deals WHERE id = $1`,
    [dealId],
  );
  if (rows.length === 0) return { found: false, existing: null };
  const d = rows[0].d;
  return { found: true, existing: d == null ? null : String(d) };
}

/** Write expected_close_date. `onlyIfNull` double-guards the fill-only case against races. */
export async function applyCloseDate(
  client: Queryable,
  schema: string,
  dealId: string,
  value: string,
  opts: { onlyIfNull: boolean },
): Promise<void> {
  const guard = opts.onlyIfNull ? " AND expected_close_date IS NULL" : "";
  await client.query(
    `UPDATE ${quoteIdent(schema)}.deals SET expected_close_date = $1::date, updated_at = NOW() WHERE id = $2${guard}`,
    [value, dealId],
  );
}

async function resolveDeferredRow(
  client: Queryable,
  row: ImportRowInput,
  value: string,
  overwriteExisting: boolean,
): Promise<ImportRowResult> {
  const { found, existing } = await fetchDealExistingCloseDate(client, row.tenantSchema, row.dealId);
  const { outcome, writeValue } = classifyImportRow({
    parsed: { status: "ok", value },
    keyValid: true,
    found,
    existing,
    overwriteExisting,
  });
  return { ...row, outcome, value: writeValue, existing };
}

/**
 * Apply a set of filled rows. Dry-run (default) only reads + classifies. Commit
 * groups writes into one transaction per tenant; each row is wrapped in a
 * SAVEPOINT so a single failing row rolls back only itself and never aborts the
 * rest of the run. Outcomes are derived from a read-then-classify, so the safe
 * default (never clobber an existing date; flag CONFLICT) holds regardless of
 * driver row-count quirks.
 */
export async function runReimport(input: {
  client: Queryable;
  rows: ImportRowInput[];
  validSchemas: Set<string>;
  mode: ReimportMode;
  overwriteExisting: boolean;
  /** Optional UUID used to attribute the audit_log rows (sets app.current_user_id). */
  actorUserId?: string | null;
}): Promise<ReimportReport> {
  const { client, rows, validSchemas, mode, overwriteExisting, actorUserId } = input;
  const results: ImportRowResult[] = new Array(rows.length);
  const deferred: Array<{ index: number; row: ImportRowInput; value: string }> = [];

  // Phase 1 — everything resolvable without touching the database.
  rows.forEach((row, index) => {
    const parsed = parseExpectedCloseDate(row.rawDate);
    if (parsed.status === "blank") {
      results[index] = { ...row, outcome: "SKIPPED_BLANK", value: null, existing: null };
      return;
    }
    if (parsed.status === "invalid") {
      results[index] = { ...row, outcome: "INVALID_DATE", value: null, existing: null, message: parsed.reason };
      return;
    }
    const keyValid = isUuid(row.dealId) && validSchemas.has(row.tenantSchema);
    if (!keyValid) {
      results[index] = {
        ...row,
        outcome: "INVALID_KEY",
        value: null,
        existing: null,
        message: isUuid(row.dealId) ? `unknown tenant schema "${row.tenantSchema}"` : "deal id is not a UUID",
      };
      return;
    }
    deferred.push({ index, row, value: parsed.value });
  });

  // Phase 2 — DB-resolved rows.
  if (mode === "dry-run") {
    for (const { index, row, value } of deferred) {
      try {
        results[index] = await resolveDeferredRow(client, row, value, overwriteExisting);
      } catch (err) {
        results[index] = { ...row, outcome: "ERROR", value: null, existing: null, message: errMessage(err) };
      }
    }
  } else {
    const byTenant = new Map<string, Array<{ index: number; row: ImportRowInput; value: string }>>();
    for (const item of deferred) {
      const bucket = byTenant.get(item.row.tenantSchema);
      if (bucket) bucket.push(item);
      else byTenant.set(item.row.tenantSchema, [item]);
    }

    const attribute = actorUserId && isUuid(actorUserId) ? actorUserId : null;
    for (const [, items] of byTenant) {
      try {
        await client.query("BEGIN");
        // Attribute audit_log rows to the operator (txn-local). Only a valid UUID is
        // set, since the audit trigger casts app.current_user_id to ::uuid.
        if (attribute) await client.query("SELECT set_config('app.current_user_id', $1, true)", [attribute]);
        for (const { index, row, value } of items) {
          await client.query("SAVEPOINT cd_row");
          try {
            const res = await resolveDeferredRow(client, row, value, overwriteExisting);
            if (res.outcome === "WRITTEN" || res.outcome === "OVERWRITTEN") {
              await applyCloseDate(client, row.tenantSchema, row.dealId, value, {
                onlyIfNull: res.outcome === "WRITTEN",
              });
            }
            await client.query("RELEASE SAVEPOINT cd_row");
            results[index] = res;
          } catch (err) {
            await client.query("ROLLBACK TO SAVEPOINT cd_row");
            await client.query("RELEASE SAVEPOINT cd_row");
            results[index] = { ...row, outcome: "ERROR", value: null, existing: null, message: errMessage(err) };
          }
        }
        await client.query("COMMIT");
      } catch (err) {
        try {
          await client.query("ROLLBACK");
        } catch {
          /* ignore */
        }
        // The whole tenant transaction rolled back, so EVERY row in this batch is
        // unpersisted — overwrite any provisional WRITTEN/NOOP/etc. with ERROR so
        // the totals and audit CSV never claim a write that did not survive.
        for (const { index, row } of items) {
          results[index] = {
            ...row,
            outcome: "ERROR",
            value: null,
            existing: null,
            message: `tenant transaction rolled back: ${errMessage(err)}`,
          };
        }
      }
    }
  }

  const counts = emptyCounts();
  for (const result of results) {
    counts[result.outcome] += 1;
    counts.total += 1;
  }
  return { mode, overwriteExisting, results, counts };
}
