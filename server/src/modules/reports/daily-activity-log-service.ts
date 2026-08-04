// Daily Activity Log -- the READABLE companion to Rep Activity.
//
// Rep Activity (performance-tier2-service.ts getRepActivityReport) answers "how much": counts,
// a per-day bar, a type pie, stalled accounts. It never shows an entry's CONTENT and its KPI
// breakdown does not even mention the `note` type. This report answers "what": the actual notes and
// updates a rep logged, in day order, so a manager can read down a salesperson's day.
//
// The two MUST agree on volume. To guarantee that structurally rather than by coincidence, this
// service imports buildActivityScopeSql and resolveRepActivityScope from the tier-2 service instead
// of restating either. With no type filter applied, `days[].entryCount` here is produced by a query
// that is the same shape as Rep Activity's `timeline` over the same predicate, so the two reconcile
// row-for-row. (Proven, not asserted: see the cross-service reconciliation case in
// server/tests/modules/reports/daily-activity-log.runtime.test.ts, which calls BOTH services against
// one seeded database and compares their per-day numbers.)
//
// ---------------------------------------------------------------------------------------------
// DATE BASIS -- occurred_at, deliberately.
// ---------------------------------------------------------------------------------------------
// activities carries two timestamps: occurred_at (when the work happened) and created_at (when the
// rep logged it in the CRM). They diverge whenever someone back-dates or writes their day up later.
//
// The ask ("what notes were added each day") leans created_at; the intent behind it ("track what
// sales people have done throughout the day") leans occurred_at. We group by occurred_at, for two
// reasons: it is the question a manager is actually asking (what work happened that day), and it is
// what Rep Activity already groups by -- a report sitting one nav entry away that split the same
// activities into different days would be exactly the two-reports-two-numbers problem this codebase
// keeps hitting.
//
// Choosing occurred_at alone would hide the thing a manager most wants to catch, so every row also
// carries `loggedDate` and `loggedSameDay`, and `loggedDaysDiff` (loggedDate - occurredDate in whole
// days: positive = written up late, negative = dated into the future). The per-day header exposes
// `offDayLoggedCount` so a day that was entirely reconstructed after the fact is visible at a glance
// without opening every entry.
//
// Bucketing detail: the day bucket is `a.occurred_at::date`, the SAME expression Rep Activity's
// timeline uses. That cast resolves against the Postgres session TimeZone (the API sets none, so in
// practice UTC), NOT the America/Chicago business timezone from server/src/lib/period.ts. That is a
// conscious call: period.ts is canonical for the period WINDOW (dateFrom/dateTo, which arrive via the
// shared ReportFilterBar and are applied by buildActivityScopeSql), but re-bucketing the days in
// business time here while Rep Activity buckets in session time would make the neighbouring report
// disagree with this one on any activity logged in the CT/UTC overlap. Matching the existing report
// is worth more than matching an ideal. If Rep Activity's timeline ever moves to a business-tz
// bucket, move this with it in the SAME change.

import { sql, type SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import { ACTIVITY_TYPES, type ActivityType } from "@trock-crm/shared/types";
import type { UserRole } from "@trock-crm/shared/types";
import {
  buildActivityScopeSql,
  resolveRepActivityScope,
  type PerformanceReportFilters,
} from "./performance-tier2-service.js";

type TenantDb = NodePgDatabase<typeof schema>;
type ExecuteRows = { rows: unknown[] } | unknown[];

// A day of one rep's log is tens of rows; a day across the whole team in a 90-day default window is
// tens of thousands. We page rather than cap-and-hope: the response always reports `total`, so the
// UI can say "showing 1-200 of 1,432" instead of silently presenting a truncated list as the whole
// story. MAX_LIMIT stops a hand-crafted ?limit=100000 from pulling the table through the API.
export const DAILY_ACTIVITY_LOG_DEFAULT_LIMIT = 200;
export const DAILY_ACTIVITY_LOG_MAX_LIMIT = 500;

export interface DailyActivityLogOptions {
  types: ActivityType[];
  page: number;
  limit: number;
}

export interface DailyActivityLogEntry {
  id: string;
  type: ActivityType;
  typeLabel: string;
  occurredAt: string;
  occurredDate: string;
  loggedAt: string;
  loggedDate: string;
  loggedSameDay: boolean;
  loggedDaysDiff: number;
  responsibleUserId: string;
  responsibleName: string;
  /** Only set when someone OTHER than the responsible rep actually logged it -- null when they match. */
  performedByName: string | null;
  subject: string | null;
  body: string | null;
  outcome: string | null;
  nextStep: string | null;
  nextStepDueAt: string | null;
  durationMinutes: number | null;
  targetType: string | null;
  targetName: string | null;
  dealId: string | null;
  dealName: string | null;
  dealNumber: string | null;
}

export interface DailyActivityLogDay {
  date: string;
  entryCount: number;
  noteCount: number;
  repCount: number;
  offDayLoggedCount: number;
  entries: DailyActivityLogEntry[];
}

export interface DailyActivityLogReport {
  kpis: {
    totalEntries: number;
    notes: number;
    daysCovered: number;
    repsLogging: number;
    offDayLogged: number;
  };
  days: DailyActivityLogDay[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    returned: number;
    totalPages: number;
    hasMore: boolean;
  };
  appliedTypes: ActivityType[];
}

interface DayCountRow {
  day: string;
  entries: number | string | null;
  notes: number | string | null;
  reps: number | string | null;
  off_day_logged: number | string | null;
}

interface TotalsRow {
  total: number | string | null;
  notes: number | string | null;
  days_covered: number | string | null;
  reps_logging: number | string | null;
  off_day_logged: number | string | null;
}

interface EntryRow {
  id: string;
  type: string;
  occurred_at: string | Date;
  occurred_day: string;
  created_at: string | Date;
  logged_day: string;
  logged_days_diff: number | string | null;
  responsible_user_id: string;
  responsible_name: string | null;
  performed_by_name: string | null;
  subject: string | null;
  body: string | null;
  outcome: string | null;
  next_step: string | null;
  next_step_due_at: string | Date | null;
  duration_minutes: number | string | null;
  target_type: string | null;
  target_name: string | null;
  deal_id: string | null;
  deal_name: string | null;
  deal_number: string | null;
}

function rowsFromExecute<T>(result: ExecuteRows): T[] {
  return (Array.isArray(result) ? result : result.rows) as T[];
}

function numberValue(value: number | string | null | undefined) {
  return Number(value ?? 0);
}

function nullableNumber(value: number | string | null | undefined) {
  return value === null || value === undefined ? null : Number(value);
}

function titleCase(value: string | null | undefined) {
  return (value || "Other").replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function isoOrNull(value: string | Date | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

/**
 * Parse the report-specific query params. The date/office/owner half of the filter set is handled by
 * the shared normalizePerformanceReportFilters -- this only covers what the log adds on top.
 *
 * `types`: comma-separated activity types; anything not in ACTIVITY_TYPES is dropped rather than
 * erroring, so a stale bookmark degrades to a wider result instead of a 400. An empty list means
 * "all types" -- which is also the state in which this report reconciles to Rep Activity.
 */
export function normalizeDailyActivityLogOptions(input: Record<string, unknown> = {}): DailyActivityLogOptions {
  const typeValue = Array.isArray(input.types)
    ? input.types.join(",")
    : typeof input.types === "string"
      ? input.types
      : "";
  const requested = typeValue.split(",").map((value) => value.trim()).filter(Boolean);
  const allowed = new Set<string>(ACTIVITY_TYPES);
  // De-duplicate while preserving ACTIVITY_TYPES order so the applied-filter echo is stable.
  const types = ACTIVITY_TYPES.filter((type) => requested.includes(type) && allowed.has(type));

  const pageRaw = Number(input.page);
  const page = Number.isInteger(pageRaw) && pageRaw > 0 ? pageRaw : 1;

  const limitRaw = Number(input.limit);
  const limit = Number.isInteger(limitRaw) && limitRaw > 0
    ? Math.min(limitRaw, DAILY_ACTIVITY_LOG_MAX_LIMIT)
    : DAILY_ACTIVITY_LOG_DEFAULT_LIMIT;

  return { types: [...types], page, limit };
}

/**
 * The activity-type predicate, appended to the SHARED scope. Compares on ::text so the bound
 * parameters never have to be inferred into the activity_type enum. No filter -> no clause, which is
 * what keeps the unfiltered report identical in volume to Rep Activity.
 */
function buildTypeFilterSql(types: ActivityType[]): SQL | null {
  if (types.length === 0) return null;
  return sql`a.type::text IN (${sql.join(types.map((type) => sql`${type}`), sql`, `)})`;
}

function buildLogScopeSql(filters: PerformanceReportFilters, ownerIds: string[], types: ActivityType[]) {
  const scope = buildActivityScopeSql(filters, ownerIds);
  const typeClause = buildTypeFilterSql(types);
  return typeClause ? sql`${scope} AND ${typeClause}` : scope;
}

// The join chain is identical to Rep Activity's: office scoping hangs off the RESPONSIBLE USER's
// office (o.id/o.slug/o.name are the aliases buildActivityScopeSql emits), not the deal's. Keeping
// the aliases `a`, `u`, `o` is load-bearing -- the shared predicate references them by name.
const LOG_BASE_JOINS = sql`
  FROM activities a
  JOIN users u ON u.id = a.responsible_user_id
  JOIN offices o ON o.id = u.office_id
`;

export async function getDailyActivityLogReport(
  db: TenantDb,
  filters: PerformanceReportFilters,
  options: DailyActivityLogOptions,
  user: { role: UserRole; userId: string; displayName?: string | null }
): Promise<DailyActivityLogReport> {
  // Same scoping rule as Rep Activity, via the same function: role "rep" collapses the owner filter
  // to the caller's own id, so a rep reading this log sees only their own entries no matter what
  // ownerIds the client sent. Any other role (route is admin/director/rep) keeps the requested
  // filter, and an empty filter means office-wide.
  const ownerIds = resolveRepActivityScope(user, filters.ownerIds);
  const scopedFilters = { ...filters, ownerIds };
  const scope = buildLogScopeSql(scopedFilters, ownerIds, options.types);

  // Deliberately NOT wrapped in the tier-2 withReportCache. That cache exists to spare repeated
  // aggregate scans for chart-shaped reports with a 5-minute TTL; this is a live log a manager
  // refreshes to see what the team just did, and serving five-minute-old entries as "today" would
  // misread as "nobody has logged anything".

  // 1) Per-day counts over the FULL result set -- NOT over the current page. A day header must state
  //    how many entries that day really has, otherwise paging would silently restate the day totals
  //    and break the reconcile to Rep Activity's timeline.
  const dayCounts = await db.execute(sql`
    SELECT a.occurred_at::date::text AS day,
      COUNT(*)::int AS entries,
      COUNT(*) FILTER (WHERE a.type = 'note')::int AS notes,
      COUNT(DISTINCT a.responsible_user_id)::int AS reps,
      COUNT(*) FILTER (WHERE a.created_at::date <> a.occurred_at::date)::int AS off_day_logged
    ${LOG_BASE_JOINS}
    WHERE ${scope}
    GROUP BY a.occurred_at::date
    ORDER BY day DESC
  `);

  // 2) Headline totals. daysCovered/repsLogging are COUNT(DISTINCT ...) across the whole window, so
  //    they cannot be summed out of the per-day rows.
  const totals = await db.execute(sql`
    SELECT COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE a.type = 'note')::int AS notes,
      COUNT(DISTINCT a.occurred_at::date)::int AS days_covered,
      COUNT(DISTINCT a.responsible_user_id)::int AS reps_logging,
      COUNT(*) FILTER (WHERE a.created_at::date <> a.occurred_at::date)::int AS off_day_logged
    ${LOG_BASE_JOINS}
    WHERE ${scope}
  `);

  // 3) The page of readable entries. Ordered newest-first with id as a tiebreak so the ordering is
  //    total -- without it, two activities sharing an occurred_at could swap between pages and a row
  //    would be shown twice or skipped.
  const offset = (options.page - 1) * options.limit;
  const entries = await db.execute(sql`
    SELECT a.id::text AS id,
      a.type::text AS type,
      a.occurred_at,
      a.occurred_at::date::text AS occurred_day,
      a.created_at,
      a.created_at::date::text AS logged_day,
      (a.created_at::date - a.occurred_at::date)::int AS logged_days_diff,
      a.responsible_user_id::text AS responsible_user_id,
      u.display_name AS responsible_name,
      -- Surface the performer ONLY when it differs from the responsible rep; when an assistant or an
      -- integration logged on someone's behalf a manager needs to know the rep did not type it.
      CASE WHEN a.performed_by_user_id IS NOT NULL AND a.performed_by_user_id <> a.responsible_user_id
        THEN pu.display_name END AS performed_by_name,
      a.subject, a.body, a.outcome, a.next_step, a.next_step_due_at, a.duration_minutes,
      -- Deal-attached entries are the priority, so deal wins the target slot; the rest fall through
      -- in descending usefulness. source_entity_type is the last resort for an entry with no FK set.
      CASE
        WHEN a.deal_id IS NOT NULL THEN 'deal'
        WHEN a.contact_id IS NOT NULL THEN 'contact'
        WHEN a.company_id IS NOT NULL THEN 'company'
        WHEN a.lead_id IS NOT NULL THEN 'lead'
        WHEN a.property_id IS NOT NULL THEN 'property'
        ELSE a.source_entity_type::text
      END AS target_type,
      CASE
        WHEN a.deal_id IS NOT NULL THEN d.name
        WHEN a.contact_id IS NOT NULL THEN NULLIF(TRIM(CONCAT(ct.first_name, ' ', ct.last_name)), '')
        WHEN a.company_id IS NOT NULL THEN c.name
        WHEN a.lead_id IS NOT NULL THEN l.name
        WHEN a.property_id IS NOT NULL THEN p.name
        ELSE NULL
      END AS target_name,
      a.deal_id::text AS deal_id, d.name AS deal_name, d.deal_number AS deal_number
    ${LOG_BASE_JOINS}
    LEFT JOIN users pu ON pu.id = a.performed_by_user_id
    LEFT JOIN deals d ON d.id = a.deal_id
    LEFT JOIN contacts ct ON ct.id = a.contact_id
    LEFT JOIN companies c ON c.id = a.company_id
    LEFT JOIN leads l ON l.id = a.lead_id
    LEFT JOIN properties p ON p.id = a.property_id
    WHERE ${scope}
    ORDER BY a.occurred_at DESC, a.id DESC
    LIMIT ${options.limit} OFFSET ${offset}
  `);

  return buildDailyActivityLogFromRows({
    dayRows: rowsFromExecute<DayCountRow>(dayCounts),
    totalsRows: rowsFromExecute<TotalsRow>(totals),
    entryRows: rowsFromExecute<EntryRow>(entries),
    options,
  });
}

/**
 * Row-shaping split out from the query so it can be unit-tested without a database (the same
 * build*FromRows idiom the tier-2 reports use).
 *
 * Only days that have at least one entry ON THIS PAGE become sections -- but each section keeps the
 * FULL-window counts from the day-count query, so a section can legitimately read "12 entries" while
 * showing 5. The UI states the pagination range so that is not misleading.
 */
export function buildDailyActivityLogFromRows(input: {
  dayRows: DayCountRow[];
  totalsRows: TotalsRow[];
  entryRows: EntryRow[];
  options: DailyActivityLogOptions;
}): DailyActivityLogReport {
  const { options } = input;
  const totals = input.totalsRows[0];
  const total = numberValue(totals?.total);

  const dayMeta = new Map<string, DayCountRow>();
  for (const row of input.dayRows) dayMeta.set(String(row.day), row);

  const entries: DailyActivityLogEntry[] = input.entryRows.map((row) => {
    const occurredDate = String(row.occurred_day);
    const loggedDate = String(row.logged_day);
    return {
      id: row.id,
      type: row.type as ActivityType,
      typeLabel: titleCase(row.type),
      occurredAt: isoOrNull(row.occurred_at) ?? "",
      occurredDate,
      loggedAt: isoOrNull(row.created_at) ?? "",
      loggedDate,
      loggedSameDay: occurredDate === loggedDate,
      loggedDaysDiff: numberValue(row.logged_days_diff),
      responsibleUserId: row.responsible_user_id,
      responsibleName: row.responsible_name || "Unassigned",
      performedByName: row.performed_by_name || null,
      subject: row.subject,
      body: row.body,
      outcome: row.outcome,
      nextStep: row.next_step,
      nextStepDueAt: isoOrNull(row.next_step_due_at),
      durationMinutes: nullableNumber(row.duration_minutes),
      targetType: row.target_type,
      targetName: row.target_name,
      dealId: row.deal_id,
      dealName: row.deal_name,
      dealNumber: row.deal_number,
    };
  });

  const grouped = new Map<string, DailyActivityLogEntry[]>();
  for (const entry of entries) {
    const bucket = grouped.get(entry.occurredDate);
    if (bucket) bucket.push(entry);
    else grouped.set(entry.occurredDate, [entry]);
  }

  // Entry rows already arrive occurred_at DESC, so Map insertion order is newest day first.
  const days: DailyActivityLogDay[] = [...grouped.entries()].map(([date, dayEntries]) => {
    const meta = dayMeta.get(date);
    return {
      date,
      entryCount: numberValue(meta?.entries),
      noteCount: numberValue(meta?.notes),
      repCount: numberValue(meta?.reps),
      offDayLoggedCount: numberValue(meta?.off_day_logged),
      entries: dayEntries,
    };
  });

  const totalPages = total === 0 ? 0 : Math.ceil(total / options.limit);

  return {
    kpis: {
      totalEntries: total,
      notes: numberValue(totals?.notes),
      daysCovered: numberValue(totals?.days_covered),
      repsLogging: numberValue(totals?.reps_logging),
      offDayLogged: numberValue(totals?.off_day_logged),
    },
    days,
    pagination: {
      page: options.page,
      limit: options.limit,
      total,
      returned: entries.length,
      totalPages,
      hasMore: options.page * options.limit < total,
    },
    appliedTypes: options.types,
  };
}
