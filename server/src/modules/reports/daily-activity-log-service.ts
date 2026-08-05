// Daily Activity Log -- the READABLE companion to Rep Activity.
//
// Rep Activity (performance-tier2-service.ts getRepActivityReport) answers "how much": counts,
// a per-day bar, a type pie, stalled accounts. It never shows an entry's CONTENT and its KPI
// breakdown does not even mention the `note` type. This report answers "what": the actual notes and
// updates a rep logged, in day order, so a manager can read down a salesperson's day.
//
// The two MUST agree on volume. To guarantee that structurally rather than by coincidence, this
// service imports buildActivityScopeSql and resolveRepActivityScope from the tier-2 service instead
// of restating either. With no narrowing applied, `days[].entryCount` here is produced by a query
// that is the same shape as Rep Activity's `timeline` over the same predicate, so the two reconcile
// row-for-row ON THE SAME DATA. (Proven, not asserted: see the cross-service reconciliation cases in
// server/tests/modules/reports/daily-activity-log.runtime.test.ts, which call BOTH services against
// one seeded database and compare their per-day numbers.)
//
// Two documented caveats on that claim, both below in full: (a) Rep Activity is cached for 5 minutes
// and this report is not, so they can disagree transiently right after an activity is logged; (b) the
// narrowing controls narrow the LISTED ROWS only -- the day-by-day reconcile is an UNFILTERED property.
//
// ---------------------------------------------------------------------------------------------
// TWO SCOPES: the WINDOW and the NARROWING.
// ---------------------------------------------------------------------------------------------
// This report has two layers of filtering and they feed different parts of the payload.
//
//   WINDOW scope  = dates + office + owner (buildActivityScopeSql). What the report is "about".
//   NARROWING     = entry type (`types`) and logged-off-day (`loggedOffDay`) on top of the window.
//
// `kpis` is computed over the WINDOW scope ALONE. `days[].*Count`, `pagination.total` and the listed
// entries are computed over the NARROWED scope.
//
// That split is deliberate and it is the reason the KPI cards on the client can be used as filters.
// The five cards are the drill affordance: clicking "Notes" narrows the log to notes. If the cards
// were narrowed too, clicking "Notes" would rewrite the Entries card from 1,432 to 118 -- a control
// that destroys the number it was clicked from, leaving nothing to compare the narrowed set against
// and no way to tell a filtered view from a quiet week. So the cards keep describing the whole window
// and the log below them describes the narrowing; `pagination.total` is the narrowed count and the UI
// prints both ("Showing 1-118 of 118" under an Entries card reading 1,432).
//
// A useful consequence: `kpis.totalEntries` now equals Rep Activity's totalTouchpoints for the same
// window under EVERY narrowing, not just the unfiltered one, so the headline number a manager reads
// beside Rep Activity cannot drift just because a chip is on. The per-day reconcile still holds only
// when nothing is narrowed -- `days[].entryCount` follows the narrowing by design, because a day
// header that ignored the filter would not describe the rows printed underneath it.
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

/**
 * Roles that may read the CONTENT (subject/body/outcome/next step) of an email activity they do not
 * own, in THIS report only. Everything about why this exists is in the PRIVACY block inside
 * getDailyActivityLogReport -- including why it is an allowlist rather than a deleted predicate.
 */
export const EMAIL_CONTENT_READER_ROLES: ReadonlySet<UserRole> = new Set<UserRole>(["admin", "director"]);

/**
 * Whether this viewer may read the content of an email activity they do not own.
 *
 * BOTH roles must be allowlisted, and that is the whole point of this function existing.
 *
 * `role` is the EFFECTIVE office role: authMiddleware rewrites it from `user_office_access
 * .role_override` whenever the request carries an `x-office-id` the user holds a grant on, and an
 * admin can set that override to admin/director/rep. Gating a capability on it alone is the #740
 * escalation: an account whose `users.role` is `rep` but who holds a `director` override on office X
 * would arrive here as a director -- which simultaneously stops resolveRepActivityScope collapsing
 * them to their own rows AND would have put them inside this allowlist, handing them every mailbox in
 * that tenant. `baseRole` is the HOME role straight from `users.role`, never elevated by an override;
 * requireGlobalAdmin (rbac.ts) exists for exactly this reason and reads exactly this field.
 *
 * Requiring both is deliberately the STRICTER reading in the other direction too: a real admin who has
 * been scoped DOWN to `rep` for an office does not get elevated content there -- and would only be
 * seeing their own rows anyway, since resolveRepActivityScope reads the effective role.
 *
 * Absent `baseRole` => DENY, matching requireGlobalAdmin. /api/reports is mounted behind
 * authMiddleware, which sets it on every request, so this only bites a caller that forgot to pass it
 * -- and the safe answer for "I don't know who this is" is to redact.
 */
export function canReadOthersEmailContent(user: { role: UserRole; baseRole?: UserRole | null }): boolean {
  if (!user.baseRole) return false;
  return EMAIL_CONTENT_READER_ROLES.has(user.role) && EMAIL_CONTENT_READER_ROLES.has(user.baseRole);
}

export interface DailyActivityLogOptions {
  types: ActivityType[];
  /**
   * Narrow the listed rows to entries whose LOGGED day differs from the day the work occurred -- the
   * drill behind the "Logged Off-Day" KPI card. Reuses the same expression the counters use
   * (LOGGED_DAY_UTC <> OCCURRED_DAY_UTC) rather than re-deriving "off-day", so the drill can never
   * return a different set of rows than the number that was clicked.
   */
  loggedOffDay: boolean;
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
   * True when the viewer may not read this row's content: the row still counts, but subject/body/
   * outcome/nextStep are withheld. The UI must label it rather than render an entry that looks empty.
   *
   * Since the owner-approved relaxation this is only ever true for a viewer whose role is NOT in
   * EMAIL_CONTENT_READER_ROLES -- see the PRIVACY block in getDailyActivityLogReport. It is kept in
   * the payload (rather than deleted along with the redaction) because the flag is the contract the
   * client's "content private" branch renders from: widen or re-narrow the role set and the UI
   * follows without a client change.
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
  /**
   * WINDOW-scoped: dates/office/owner only, NOT the entry-type or logged-off-day narrowing. See the
   * "TWO SCOPES" block at the top of this file -- these five numbers are what the clickable KPI cards
   * render, so they must not move when a card is clicked. `pagination.total` is the narrowed count.
   */
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
    /** The NARROWED row count -- how many entries the current type/off-day selection matches. */
    total: number;
    returned: number;
    totalPages: number;
    hasMore: boolean;
  };
  appliedTypes: ActivityType[];
  /** Echoes the off-day narrowing the SERVER applied, the same way appliedTypes echoes the types. */
  appliedLoggedOffDay: boolean;
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
 *
 * `loggedOffDay`: opt-IN only. Anything other than a recognised truthy spelling means "no narrowing",
 * for the same degrade-wider reason -- a mangled param must never silently hide rows.
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

  return { types: [...types], loggedOffDay: parseFlag(input.loggedOffDay), page, limit };
}

/**
 * Express hands a repeated query param (`?loggedOffDay=0&loggedOffDay=1`) back as an ARRAY -- it has
 * no last-wins rule of its own. Last-wins is this function's choice, picked because it is what a user
 * editing the tail of a URL expects. Note it differs from the `types` handling above, which JOINS a
 * repeated param: there, every value is a legitimate member of a set; here they are contradictory
 * answers to one yes/no question.
 */
function parseFlag(value: unknown): boolean {
  const raw = Array.isArray(value) ? value[value.length - 1] : value;
  if (typeof raw === "boolean") return raw;
  if (typeof raw !== "string") return false;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
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

// "Logged off-day" is defined in exactly ONE place and every use of it -- the two counters and the
// drill filter -- points here. Re-deriving it (say, as `created_at::date <> occurred_at::date` without
// the UTC pin) is how a card comes to disagree with the rows it drills into.
const LOGGED_OFF_DAY = sql`${LOGGED_DAY_UTC} <> ${OCCURRED_DAY_UTC}`;

/**
 * The NARROWING layer: the window scope plus whatever the entry-type chips and the "Logged Off-Day"
 * drill asked for. Applied to the listed rows, the per-day counters and `pagination.total` -- never to
 * `kpis`, which stays on the bare window scope (see TWO SCOPES at the top of this file).
 *
 * No narrowing -> the window scope is returned unchanged, which is what keeps the unfiltered report
 * identical in volume to Rep Activity.
 */
function buildNarrowedScopeSql(windowScope: SQL, options: DailyActivityLogOptions) {
  const clauses: SQL[] = [];
  const typeClause = buildTypeFilterSql(options.types);
  if (typeClause) clauses.push(typeClause);
  if (options.loggedOffDay) clauses.push(LOGGED_OFF_DAY);
  return clauses.reduce<SQL>((acc, clause) => sql`${acc} AND ${clause}`, windowScope);
}

export async function getDailyActivityLogReport(
  db: TenantDb,
  filters: PerformanceReportFilters,
  options: DailyActivityLogOptions,
  user: { role: UserRole; baseRole?: UserRole | null; userId: string; displayName?: string | null }
): Promise<DailyActivityLogReport> {
  // Same scoping rule as Rep Activity, via the same function: role "rep" collapses the owner filter
  // to the caller's own id, so a rep reading this log sees only their own entries no matter what
  // ownerIds the client sent. Any other role (route is admin/director/rep) keeps the requested
  // filter, and an empty filter means office-wide.
  const ownerIds = resolveRepActivityScope(user, filters.ownerIds);
  const scopedFilters = { ...filters, ownerIds };
  // The WINDOW scope: dates + office + owner and nothing else. `kpis` is computed over exactly this,
  // the listed rows over `scope` below.
  //
  // Owner scoping inside it is by ID ONLY -- filters.ownerNames is deliberately not part of the
  // predicate. This matches Rep Activity exactly: buildActivityScopeSql emits `u.id IN (...)` and
  // performance-tier2-service never puts ownerNames into an activity predicate either. That is a
  // security decision, not an oversight -- display names are not unique, and scoping activities by
  // name leaks one rep's entries to another rep who happens to share a display name. There is a test
  // pinning it (performance-tier2-service.test.ts, "scopes rep activity by user id so duplicate
  // display names cannot leak another rep's deals"), so adding a display_name arm here would reverse
  // a guarded call AND diverge from the report this one must reconcile with.
  //
  // The client already resolves names to ids before calling: useReportFilters looks each owner name
  // up in the sales-rep list and sends ownerIds. A hand-written or legacy URL carrying only ownerNames
  // therefore yields an office-wide log rather than a filtered one -- the same behaviour Rep Activity
  // has for the same input. Fixing that belongs in a change that moves BOTH reports together.
  const windowScope = buildActivityScopeSql(scopedFilters, ownerIds);
  const scope = buildNarrowedScopeSql(windowScope, options);

  // PRIVACY: email activities carry synced mailbox content, so who may READ that content is decided
  // here, per viewer role. This report DELIBERATELY DIVERGES from the activities list endpoint. Read
  // this whole block before changing it back.
  //
  // What the two do now:
  //   activities list (server/src/modules/activities/service.ts) -- STRICTER. Restricts email content
  //     to the mailbox owner for EVERY viewer, admins included:
  //       or(type <> 'email', responsible_user_id = viewerUserId)
  //   this report -- email content is READABLE by a viewer who is admin/director BOTH as their home
  //     role and as their effective office role (canReadOthersEmailContent); withheld from everyone
  //     else. The two-role check is not belt-and-braces, it is the fix for a real escalation path --
  //     see that function's doc.
  //
  // That divergence is intentional and owner-approved, not drift: the product owner asked for email
  // content to be visible in the Daily Activity Log, whose entire purpose is that a manager can read
  // down a salesperson's day. A log that prints "content private" over the email half of that day
  // answers "how much" -- which is the neighbouring Rep Activity report's job, not this one's. The
  // activities list is a different surface with a different audience and was left alone; if it is ever
  // aligned, align it deliberately, in its own change. DO NOT "fix" this file back to match it.
  //
  // Why it is still ROLE-AWARE rather than simply deleted:
  //   resolveRepActivityScope above already collapses a `rep` viewer to their own ownerIds, so today a
  //   rep never receives another person's row at all and the redaction only ever bit admin/director.
  //   Deleting the predicate would therefore look like a no-op for reps -- and would silently become a
  //   mailbox leak the day that scoping rule changes. The allowlist keeps the two decisions
  //   independent: WHICH ROWS you get is resolveRepActivityScope's call, WHOSE CONTENT you can read is
  //   this one's, and a rep cannot read someone else's mail through this endpoint under any filter
  //   even if the first decision is loosened. requireAnyRole gates the route to the three CRM roles by
  //   EFFECTIVE role, so a `construction` account cannot reach it without an office override -- and if
  //   one is ever granted, its home role is still outside the allowlist, so the route guard and this
  //   decision cannot be widened by the same act.
  //
  // Redaction still REDACTS rather than EXCLUDES for the restricted case: the row stays, keeps its
  // type/time/rep/target so it still counts, and only the free-text content fields are nulled.
  // Dropping the rows would break the reconcile to Rep Activity, which counts email activities in
  // total_touchpoints, its `emails` breakdown and its timeline for every viewer. A count is not a
  // disclosure; the subject line is. The row is flagged so the UI can say "content private" rather
  // than render a blank entry that reads like a data bug.
  const contentRestricted = canReadOthersEmailContent(user)
    ? sql`false`
    : sql`(a.type = 'email' AND a.responsible_user_id <> ${user.userId})`;

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

  // 1) Per-day counts over the FULL NARROWED result set -- NOT over the current page. A day header
  //    must state how many entries that day really has, otherwise paging would silently restate the
  //    day totals and break the reconcile to Rep Activity's timeline. These follow the narrowing
  //    because they describe the rows printed underneath them.
  const dayCounts = await db.execute(sql`
    SELECT ${OCCURRED_DAY_UTC}::text AS day,
      COUNT(*)::int AS entries,
      COUNT(*) FILTER (WHERE a.type = 'note')::int AS notes,
      COUNT(DISTINCT a.responsible_user_id)::int AS reps,
      COUNT(*) FILTER (WHERE ${LOGGED_OFF_DAY})::int AS off_day_logged
    ${LOG_BASE_JOINS}
    WHERE ${scope}
    GROUP BY ${OCCURRED_DAY_UTC}
    ORDER BY day DESC
  `);

  // 2) Headline totals, over the WINDOW scope -- deliberately NOT `scope`. These are the five KPI
  //    cards, which are themselves the narrowing controls, so they must describe the same window
  //    before and after a card is clicked (see TWO SCOPES at the top of this file).
  //    daysCovered/repsLogging are COUNT(DISTINCT ...) and cannot be summed out of the per-day rows.
  const totals = await db.execute(sql`
    SELECT COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE a.type = 'note')::int AS notes,
      COUNT(DISTINCT ${OCCURRED_DAY_UTC})::int AS days_covered,
      COUNT(DISTINCT a.responsible_user_id)::int AS reps_logging,
      COUNT(*) FILTER (WHERE ${LOGGED_OFF_DAY})::int AS off_day_logged
    ${LOG_BASE_JOINS}
    WHERE ${windowScope}
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
  //
  //    The page is clamped against the NARROWED total, which is the sum of the per-day counts from
  //    query 1 -- those are COUNT(*) grouped by day over exactly the rows being paged, so summing them
  //    is the narrowed total by construction and costs no extra round trip. It is NOT `totals.total`
  //    any more: that one is now window-scoped and would clamp against rows the narrowing excludes.
  const totalsRows = rowsFromExecute<TotalsRow>(totals);
  const dayRows = rowsFromExecute<DayCountRow>(dayCounts);
  const totalMatching = dayRows.reduce((sum, row) => sum + numberValue(row.entries), 0);
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
      -- Content fields are nulled only for a viewer who may not read them (see contentRestricted
      -- above -- for admin/director that expression is the constant false, so nothing is nulled).
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
    dayRows,
    totalsRows,
    matchingTotal: totalMatching,
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
  /** WINDOW-scoped totals -- the KPI cards. Must NOT reflect the type/off-day narrowing. */
  totalsRows: TotalsRow[];
  /** NARROWED row count -- drives `pagination`, which describes the listed rows. */
  matchingTotal: number;
  entryRows: EntryRow[];
  options: DailyActivityLogOptions;
}): DailyActivityLogReport {
  const { options } = input;
  const totals = input.totalsRows[0];
  const total = numberValue(input.matchingTotal);

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
      totalEntries: numberValue(totals?.total),
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
    appliedLoggedOffDay: options.loggedOffDay,
  };
}
