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
// row-for-row ON THE SAME DATA. (Proven, not asserted: see the cross-service reconciliation cases in
// server/tests/modules/reports/daily-activity-log.runtime.test.ts, which call BOTH services against
// one seeded database and compare their per-day numbers.)
//
// Two documented caveats on that claim, both below in full: (a) Rep Activity is cached for 5 minutes
// and this report is not, so they can disagree transiently right after an activity is logged; (b) a
// type filter narrows this report only -- the reconcile is an UNFILTERED property.
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
// Bucketing detail: the day bucket is EXPLICITLY UTC -- `(a.occurred_at AT TIME ZONE 'UTC')::date`
// (see OCCURRED_DAY_UTC below), and Rep Activity's timeline is pinned identically in the same change
// so the two still agree by construction. It is deliberately NOT the America/Chicago business
// timezone from server/src/lib/period.ts: period.ts is canonical for the period WINDOW (dateFrom/
// dateTo, applied by buildActivityScopeSql), but re-bucketing the days in business time while Rep
// Activity buckets elsewhere would make the neighbouring report disagree with this one. If Rep
// Activity's timeline ever moves to a business-tz bucket, move this with it in the SAME change.
//
// The CLIENT renders row clocks in UTC to match (daily-activity-log-page.tsx). That is not cosmetic:
// rendered in browser-local time, an activity at 2026-06-02T00:30:00Z appears under the "Jun 2"
// header showing "7:30 PM" to a Central reader, i.e. a row contradicting its own day heading. The
// pinned bucket is what makes the page's "times UTC" label true BY CONSTRUCTION rather than true only
// while the database session happens to be UTC. If this bucket ever changes zone, the page's
// UTC_TIME formatter and its "times UTC" marker have to change with it.
//
// RESIDUAL, stated rather than hidden: the window bounds in buildActivityScopeSql still compare
// `a.occurred_at >= '<date>'::date`, which promotes the date using the SESSION timezone. That is
// shared with Rep Activity, so the two reports still agree with each other; but on a non-UTC session
// the edges of the range are session-relative while the buckets are UTC, so a boundary day can fall
// just outside the requested range. Pinning the window too would change WHICH ROWS both reports
// return, which is a wider behavioural change than this fix -- left as a deliberate follow-up.

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
  /**
   * True when this is someone ELSE'S email activity: the row still counts, but subject/body/outcome/
   * nextStep are withheld. The UI must label it rather than render an entry that looks empty.
   */
  contentRestricted: boolean;
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
  content_restricted: boolean | null;
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

/**
 * Owner scoping is by ID ONLY -- filters.ownerNames is deliberately not part of the predicate.
 *
 * This matches Rep Activity exactly: buildActivityScopeSql emits `u.id IN (...)` and
 * performance-tier2-service never puts ownerNames into an activity predicate either. That is a
 * security decision, not an oversight -- display names are not unique, and scoping activities by name
 * leaks one rep's entries to another rep who happens to share a display name. There is a test pinning
 * it (performance-tier2-service.test.ts, "scopes rep activity by user id so duplicate display names
 * cannot leak another rep's deals"), so adding a display_name arm here would reverse a guarded call
 * AND diverge from the report this one must reconcile with.
 *
 * The client already resolves names to ids before calling: useReportFilters looks each owner name up
 * in the sales-rep list and sends ownerIds. A hand-written or legacy URL carrying only ownerNames
 * therefore yields an office-wide log rather than a filtered one -- the same behaviour Rep Activity
 * has for the same input. Fixing that belongs in a change that moves BOTH reports together.
 */
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

// The day bucket, pinned to UTC rather than left to the Postgres SESSION timezone.
//
// A bare `a.occurred_at::date` casts a timestamptz using whatever TimeZone the session happens to
// carry. The API sets none, so it inherits the server default — which is why the runtime suite has to
// `SET TimeZone='UTC'` to get deterministic buckets. That made the client's "times UTC" label a claim
// about the DATA that the QUERY did not guarantee: on an America/Chicago session, 2026-06-02T04:30Z
// files under Jun 1 while the page renders it as 4:30 AM "times UTC" (a Jun 2 time under a Jun 1
// heading) — the exact row/header contradiction the UTC rendering was introduced to remove.
//
// Pinning the SQL removes the dependency instead of tracking it, so the label is true by construction
// on any server. Rep Activity's timeline bucket is pinned identically in the same change: the two
// reports must agree, and they only do so by construction if they bucket in the same zone. (Under a
// UTC session — the expected production configuration — this is a no-op; it is the non-UTC case that
// silently diverged before.)
const OCCURRED_DAY_UTC = sql.raw("(a.occurred_at AT TIME ZONE 'UTC')::date");
const LOGGED_DAY_UTC = sql.raw("(a.created_at AT TIME ZONE 'UTC')::date");

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

  // PRIVACY: email activities carry synced mailbox content. The activities list endpoint
  // (server/src/modules/activities/service.ts) restricts them to the mailbox owner for every viewer:
  //   or(type <> 'email', responsible_user_id = viewerUserId)
  // That rule has to hold here too, or an admin/director selecting the Email chip would read other
  // people's mail. But EXCLUDING those rows would break the reconcile to Rep Activity, which counts
  // email activities in total_touchpoints, its `emails` breakdown and its timeline for every viewer
  // (verified: there is no viewerUserId predicate anywhere in the reports module). A count is not a
  // disclosure; the subject line is.
  //
  // So we REDACT instead of exclude: the row stays, keeps its type/time/rep/target so it still counts
  // and still explains the day's volume, and only the free-text content fields are nulled. Reconcile
  // and privacy both hold. The row is flagged so the UI can say "content private" rather than render a
  // blank entry that reads like a data bug.
  const contentRestricted = sql`(a.type = 'email' AND a.responsible_user_id <> ${user.userId})`;

  // Deliberately NOT wrapped in the tier-2 withReportCache. That cache exists to spare repeated
  // aggregate scans for chart-shaped reports with a 5-minute TTL; this is a live log a manager
  // refreshes to see what the team just did, and serving five-minute-old entries as "today" would
  // misread as "nobody has logged anything".
  //
  // KNOWN TRADE-OFF (be honest about it): Rep Activity IS cached for 5 minutes, so for up to 5 minutes
  // after a new activity is logged this log shows it and Rep Activity's timeline does not. The two
  // reconcile EXACTLY on the same underlying data -- same predicate, same date basis, proven by the
  // cross-service runtime tests -- but they can disagree transiently while that cache is warm.
  // The alternative, clearing the report cache on every activity write, would effectively disable
  // caching for every tier-2 report (activities are written constantly) to fix a 5-minute display
  // skew, so it was not taken. The UI states the window rather than pretending it does not exist.

  // 1) Per-day counts over the FULL result set -- NOT over the current page. A day header must state
  //    how many entries that day really has, otherwise paging would silently restate the day totals
  //    and break the reconcile to Rep Activity's timeline.
  const dayCounts = await db.execute(sql`
    SELECT ${OCCURRED_DAY_UTC}::text AS day,
      COUNT(*)::int AS entries,
      COUNT(*) FILTER (WHERE a.type = 'note')::int AS notes,
      COUNT(DISTINCT a.responsible_user_id)::int AS reps,
      COUNT(*) FILTER (WHERE ${LOGGED_DAY_UTC} <> ${OCCURRED_DAY_UTC})::int AS off_day_logged
    ${LOG_BASE_JOINS}
    WHERE ${scope}
    GROUP BY ${OCCURRED_DAY_UTC}
    ORDER BY day DESC
  `);

  // 2) Headline totals. daysCovered/repsLogging are COUNT(DISTINCT ...) across the whole window, so
  //    they cannot be summed out of the per-day rows.
  const totals = await db.execute(sql`
    SELECT COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE a.type = 'note')::int AS notes,
      COUNT(DISTINCT ${OCCURRED_DAY_UTC})::int AS days_covered,
      COUNT(DISTINCT a.responsible_user_id)::int AS reps_logging,
      COUNT(*) FILTER (WHERE ${LOGGED_DAY_UTC} <> ${OCCURRED_DAY_UTC})::int AS off_day_logged
    ${LOG_BASE_JOINS}
    WHERE ${scope}
  `);

  // 3) The page of readable entries. Ordered newest-first with id as a tiebreak so the ordering is
  //    total -- without it, two activities sharing an occurred_at could swap between pages and a row
  //    would be shown twice or skipped.
  //
  //    The requested page is CLAMPED to the last page that actually exists. A bookmarked ?page=9, or a
  //    page that fell off the end after activities were deleted, would otherwise return total>0 with
  //    zero rows -- which the UI renders as "nothing was logged in this window" while the footer reads
  //    "0-0 of 6 - page 9 of 3". Clamping server-side means the response always describes the page it
  //    really served, so the client needs no special case.
  const totalsRows = rowsFromExecute<TotalsRow>(totals);
  const totalMatching = numberValue(totalsRows[0]?.total);
  const lastPage = totalMatching === 0 ? 1 : Math.ceil(totalMatching / options.limit);
  const effectivePage = Math.min(options.page, lastPage);
  const servedOptions = { ...options, page: effectivePage };
  const offset = (effectivePage - 1) * options.limit;
  const entries = await db.execute(sql`
    SELECT a.id::text AS id,
      a.type::text AS type,
      a.occurred_at,
      ${OCCURRED_DAY_UTC}::text AS occurred_day,
      a.created_at,
      ${LOGGED_DAY_UTC}::text AS logged_day,
      (${LOGGED_DAY_UTC} - ${OCCURRED_DAY_UTC})::int AS logged_days_diff,
      a.responsible_user_id::text AS responsible_user_id,
      u.display_name AS responsible_name,
      -- Surface the performer ONLY when it differs from the responsible rep; when an assistant or an
      -- integration logged on someone's behalf a manager needs to know the rep did not type it.
      CASE WHEN a.performed_by_user_id IS NOT NULL AND a.performed_by_user_id <> a.responsible_user_id
        THEN pu.display_name END AS performed_by_name,
      -- Content fields are nulled for other people's email activities (see contentRestricted above).
      -- next_step_due_at goes with next_step: a due date without its step is noise, and it is still
      -- mailbox-derived. Type, time, rep, target and duration stay so the row remains countable.
      CASE WHEN ${contentRestricted} THEN NULL ELSE a.subject END AS subject,
      CASE WHEN ${contentRestricted} THEN NULL ELSE a.body END AS body,
      CASE WHEN ${contentRestricted} THEN NULL ELSE a.outcome END AS outcome,
      CASE WHEN ${contentRestricted} THEN NULL ELSE a.next_step END AS next_step,
      CASE WHEN ${contentRestricted} THEN NULL ELSE a.next_step_due_at END AS next_step_due_at,
      ${contentRestricted} AS content_restricted,
      a.duration_minutes,
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
    totalsRows,
    entryRows: rowsFromExecute<EntryRow>(entries),
    options: servedOptions,
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
      contentRestricted: row.content_restricted === true,
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
