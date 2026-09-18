// Canvassing Activity -- who is putting NEW names into the CRM, and how many, per week/month/quarter.
//
// Asked for by Colby Burling (Aug 7 2026) for the Atlanta lead-generation push: "Report that shows
// individual activity for entering new companies, properties, and contacts", so canvassing can be measured
// rather than assumed. Leads are counted alongside those three because a canvassed building usually lands
// as a lead, and a report that stopped at the directory would understate the work.
//
// ---------------------------------------------------------------------------------------------
// WHAT "NEW" MEANS, AND WHY IT COULD NOT BE ANSWERED BEFORE
// ---------------------------------------------------------------------------------------------
// Only `leads` recorded who created a row (`created_by_user_id`, migration 0128). For the other three:
//
//   * companies/contacts had `owner_id`, which is ASSIGNMENT. It is set to the creator on an interactive
//     create, but it is reassigned freely afterwards, so it answers "whose account is this now", not "who
//     found it". Counting canvassing off it would move a week's credit every time a book was rebalanced.
//   * `properties` had neither. There was no column, anywhere, naming who added a property.
//   * the audit_log cannot stand in. Among the four tables only `contacts` carries an audit trigger, and
//     even there `changed_by` is null on ~95% of insert rows, because imports and syncs carry no session.
//
// Migration 0220 adds `created_by_user_id` to companies, properties and contacts to close that. It is NOT
// backfilled and cannot be -- the information was never recorded. So:
//
//   **This report is accurate from the deploy forward, and reads as zero before it.**
//
// That is stated in the payload rather than left for someone to discover: `attributionStartHint` carries
// the earliest attributed creation the office has, and every bucket reports `unattributed` counts beside
// the per-person ones. A week showing "Edward: 0 companies, 14 unattributed" is a week that predates the
// column or was machine-created -- visibly different from a week where he genuinely added nothing.
//
// ---------------------------------------------------------------------------------------------
// COUNTING RULES, all deliberate
// ---------------------------------------------------------------------------------------------
// ACTIVE ONLY, WITH ONE EXCEPTION THAT MATTERS. Soft-deleted rows do not count: canvassing credit should
// not survive the cleanup of a duplicate someone entered twice, and the reports suite already treats
// is_active=true as the population. The consequence, stated because it is surprising: a past week's number
// can go DOWN if a record entered then is deactivated later. That is the intended direction -- the
// alternative pays for duplicates.
//
// THE EXCEPTION IS LEADS. Both TERMINAL statuses set is_active=false while keeping the status: converting
// a lead and disqualifying one both take that path. Those are outcomes, not deletions, so the rule is
// `is_active = true OR status IN ('converted','disqualified')`. Without it the report docked a canvasser
// the moment their lead paid off, and again when one turned out not to qualify -- and 155 of the 209 leads
// in office_dallas are converted+inactive, so it would have hidden most of the lead column outright.
//
// TEST DATA EXCLUDED, via COALESCE(is_test_data,false)=false, matching every other report here.
//
// BUSINESS TIMEZONE (America/Chicago) for both the window and the buckets, from server/src/lib/period.ts.
// Unlike the Daily Activity Log -- which pins UTC so it reconciles row-for-row with Rep Activity -- this
// report has no sibling to agree with, and its unit is "the week the team worked", which is a business-tz
// question. Weeks are SUNDAY-anchored via the platform's canonical sundayWeekBucketSql, so a week here
// starts the same day it starts on the dashboard.
//
// ATTRIBUTION FOR NOTES uses activities.responsible_user_id, the same column Rep Activity and the Daily
// Activity Log attribute by, so "notes logged" means the same thing on all three surfaces.

import { sql, type SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import {
  BUSINESS_TIMEZONE,
  businessToday,
  shiftBusinessDate,
  sundayWeekBucketSql,
  sundayWeekStart,
} from "../../lib/period.js";

type TenantDb = NodePgDatabase<typeof schema>;

export const CANVASSING_BUCKETS = ["week", "month", "quarter"] as const;
export type CanvassingBucket = (typeof CANVASSING_BUCKETS)[number];

/** The four things a canvasser puts into the CRM. Order is the display order. */
export const CANVASSING_KINDS = ["company", "property", "contact", "lead"] as const;
export type CanvassingKind = (typeof CANVASSING_KINDS)[number];

export interface CanvassingActivityFilters {
  dateFrom: string;
  dateTo: string;
  bucket: CanvassingBucket;
  /**
   * Narrow to specific people. These are ALSO pinned into the output at zero when they entered nothing,
   * which is the point of an accountability report — "Caleb: 0 this week" has to be visible, and it is
   * not if the roster is built only from rows that exist.
   */
  userIds?: string[];
  /** Cap on the notes feed. The counts are never capped; only the readable list is. */
  notesLimit?: number;
  /**
   * Owner selections in their legacy NAME / EMAIL forms. The filter bar writes `?owners=` and
   * `?ownerEmails=` alongside `?ownerIds=`, resolves them locally and visibly ticks the person — but only
   * ids reached this report, so the page showed a person filtered while the numbers stayed office-wide
   * until someone pressed Apply. Resolved here so every form the URL supports means the same thing.
   */
  ownerNames?: string[];
  ownerEmails?: string[];
  /**
   * The office this request is scoped to. `users` is a single GLOBAL table, so without it a crafted
   * ?userIds=<uuid> for an account in another office would be looked up and its name, email, role and
   * active flag returned as a zero-count row — reading the global directory through a tenant report.
   */
  officeId?: string | null;
  /** Set by the normalizer when it shortened an over-long window. */
  rangeClamped?: boolean;
  /**
   * The viewer's HOME role (users.role), NOT the per-office effective one.
   *
   * Only the NOTES FEED uses it: an allowlisted viewer holding `rep` reads their own notes rather than the
   * whole office's, matching GET /activities and the Daily Activity Log. Counts are unaffected — a
   * scoreboard of how many is not the same disclosure as the text itself.
   *
   * baseRole rather than role for the #740 escalation shape: authMiddleware rewrites `role` from a
   * per-office role_override, so a rep holding a director override on some office would otherwise read that
   * office's note content. The Daily Activity Log gates its email content on baseRole for the same reason.
   */
  viewerRole?: string | null;
  /**
   * The EFFECTIVE (per-office) role, alongside the home one above. The notes gate restricts when EITHER is
   * `rep`: baseRole alone would miss someone whose home role is director but who holds a rep override in
   * this office, and effective-role alone is the #740 escalation shape in reverse. Restricting on either
   * is the only reading that cannot widen.
   */
  viewerEffectiveRole?: string | null;
  viewerUserId?: string | null;
}

export type CanvassingCounts = Record<CanvassingKind, number> & { total: number };

export interface CanvassingPersonRow {
  userId: string;
  displayName: string;
  email: string | null;
  role: string | null;
  isActive: boolean;
  counts: CanvassingCounts;
  notesLogged: number;
}

export interface CanvassingBucketRow {
  bucketStart: string;
  label: string;
  /**
   * True when the requested range covers only PART of this calendar period — which is the normal case for
   * the first and last bucket of any range that does not start on a Sunday / the 1st. Without it a clipped
   * week is charted beside whole ones and reads as a quiet week rather than a partial one.
   */
  partial: boolean;
  counts: CanvassingCounts;
  unattributed: CanvassingCounts;
  perUser: Array<{ userId: string; counts: CanvassingCounts; notesLogged: number }>;
}

export interface CanvassingNoteRow {
  id: string;
  type: string;
  subject: string | null;
  body: string | null;
  occurredAt: string;
  userId: string | null;
  userName: string | null;
  /** Set only when someone OTHER than the attributed user actually logged it. */
  performedByName: string | null;
  targetType: "company" | "property" | "contact" | "lead" | "deal" | null;
  targetId: string | null;
  targetName: string | null;
}

export interface CanvassingActivityReport {
  /** The window actually reported on — which is not always the one requested; see `rangeClamped`. */
  range: { from: string; to: string };
  /**
   * True when the requested window was longer than the supported maximum and `range.from` was moved
   * forward. The filter bar keeps displaying what was typed, so without this the page would show one
   * window and describe another.
   */
  rangeClamped: boolean;
  bucket: CanvassingBucket;
  totals: CanvassingCounts;
  unattributed: CanvassingCounts;
  notesLogged: number;
  people: CanvassingPersonRow[];
  buckets: CanvassingBucketRow[];
  notes: CanvassingNoteRow[];
  notesTruncated: boolean;
  /**
   * The feed was narrowed to the viewer's OWN notes because they hold the rep role, while `notesLogged` and
   * the per-person counts still describe everyone. Stated by the server rather than inferred, so every
   * surface that renders the feed — the page, the export — can say the same thing about why it is short.
   */
  notesRestrictedToSelf: boolean;
  /**
   * Earliest attributed creation in this office, or null if nothing has ever been attributed. The client
   * prints "attribution starts <date>" so a zero before that date is not misread as inactivity.
   */
  attributionStartHint: string | null;
}

/** ~5 years. Long enough for any real quarterly comparison, short enough to stay one screen of buckets. */
const MAX_RANGE_DAYS = 1830;
const DEFAULT_NOTES_LIMIT = 200;
const MAX_NOTES_LIMIT = 500;

/**
 * Stands in for an owner selection that matched nobody, so the request stays a FILTER (matching nothing)
 * rather than degrading to no filter at all. A nil uuid never identifies a real user.
 */
const UNRESOLVABLE_OWNER = "00000000-0000-0000-0000-000000000000";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A date that is both ISO-SHAPED and real.
 *
 * The shape test alone accepts "2026-13-45" and "2026-02-30", which Postgres then rejects with
 * "date/time field value out of range" — turning a stale bookmark into a 500, the exact opposite of what
 * this normalizer promises. Round-tripping through Date catches both the out-of-range month/day and the
 * silently-rolled-over ones (Feb 30 -> Mar 2).
 */
export function isRealIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  // Postgres has no year zero, so `0000-01-01::date` errors even though JavaScript round-trips it happily
  // — a stale bookmark would 500 rather than fall back, which is the failure this function exists to stop.
  if (value.startsWith("0000")) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * Every calendar bucket in the range, whether or not anything happened in it.
 *
 * A period with no creations and no notes produced no row at all, so weeks 1 and 3 rendered as adjacent
 * columns and week 2 vanished — the page claims an explicit zero is the finding, and then hid the emptiest
 * weeks of all. A pinned person who did nothing all range got an empty table rather than a row of zeros.
 */
function bucketStartsInRange(bucket: CanvassingBucket, from: string, to: string): string[] {
  const startOf = (iso: string): string => {
    if (bucket === "week") return sundayWeekStart(iso);
    const [y, m] = iso.split("-").map(Number);
    const month = bucket === "month" ? m : Math.floor((m - 1) / 3) * 3 + 1;
    return `${String(y).padStart(4, "0")}-${String(month).padStart(2, "0")}-01`;
  };
  // One definition of "the next period", shared with isPartialBucket, so the two cannot disagree about the
  // edge of the representable range.
  const next = (iso: string): string => bucketEndExclusive(bucket, iso);

  const out: string[] = [];
  // Bounded independently of the loop body: a malformed range must not be able to spin here.
  // The range is already clamped to MAX_RANGE_DAYS by normalizeCanvassingFilters, so this cannot truncate a
  // real request; it is a backstop against a caller constructing filters directly.
  // Stops before a five-digit year: 9999-12-31 is a legal bound, and advancing past it would emit
  // "10000-01-01", which no consumer of these keys can parse.
  for (let cursor = startOf(from); cursor <= to && out.length < 4096; cursor = next(cursor)) {
    out.push(cursor);
    if (next(cursor) === cursor || next(cursor) >= MAX_ISO_DATE) break;
  }
  return out;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function zeroCounts(): CanvassingCounts {
  return { company: 0, property: 0, contact: 0, lead: 0, total: 0 };
}

function addTo(counts: CanvassingCounts, kind: CanvassingKind, n: number) {
  counts[kind] += n;
  counts.total += n;
}

/**
 * Normalize the query string into filters.
 *
 * Anything unparseable falls back to a default rather than throwing: a stale bookmark should show a
 * sensible report, not an error. The ONE thing that is not defaulted away is `userIds` — an id that is
 * not a UUID is dropped, because interpolating it would be the injection surface on this endpoint.
 */
export function normalizeCanvassingFilters(query: Record<string, unknown>): CanvassingActivityFilters {
  const pick = (value: unknown): string => {
    if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : "";
    return typeof value === "string" ? value : "";
  };

  const rawFrom = pick(query.dateFrom).trim();
  const rawTo = pick(query.dateTo).trim();
  const bucketRaw = pick(query.bucket).trim().toLowerCase();
  const bucket = (CANVASSING_BUCKETS as readonly string[]).includes(bucketRaw)
    ? (bucketRaw as CanvassingBucket)
    : "week";

  // A missing/garbled range defaults to the trailing 12 weeks. Anchored on the BUSINESS date, not
  // toISOString(): between ~19:00 and midnight Chicago the UTC date is already tomorrow, which would put
  // `dateTo` a day past the business date every other calculation in this file uses.
  const fallbackTo = businessToday();
  const fallbackFrom = shiftBusinessDate(fallbackTo, -83);

  let from = isRealIsoDate(rawFrom) ? rawFrom : fallbackFrom;
  let to = isRealIsoDate(rawTo) ? rawTo : fallbackTo;
  // An inverted range returns nothing at all, which reads as "nobody did anything" rather than as a bad
  // URL. Swapping is the interpretation that keeps the page honest.
  if (from > to) [from, to] = [to, from];
  // Clamp the WINDOW rather than capping the bucket loop. Truncating the loop silently dropped periods out
  // of a grid that promises every one of them, and the gap had no explanation anywhere in the payload; the
  // returned `range` reflects this clamp, so the page always describes the window it actually reports on.
  const earliest = shiftBusinessDate(to, -(MAX_RANGE_DAYS - 1));
  const rangeClamped = from < earliest;
  if (rangeClamped) from = earliest;

  const rawUserIds = pick(query.userIds)
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  const userIds = rawUserIds.filter((value) => UUID.test(value));
  // A selector that was PRESENT but resolved to nothing stays a filter matching nothing. Dropping it
  // entirely would turn a corrupted person-filtered bookmark into a whole-office report.
  const userIdsWereRequested = rawUserIds.length > 0;
  const splitList = (raw: string) =>
    raw.split(",").map((value) => value.trim()).filter((value) => value.length > 0 && value.length <= 320);
  const ownerNames = splitList(pick(query.owners) || pick(query.ownerNames));
  const ownerEmails = splitList(pick(query.ownerEmails));

  const limitRaw = Number(pick(query.notesLimit));
  const notesLimit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), MAX_NOTES_LIMIT) : DEFAULT_NOTES_LIMIT;

  return {
    dateFrom: from,
    dateTo: to,
    bucket,
    rangeClamped,
    userIds: userIds.length > 0 ? userIds : userIdsWereRequested ? [UNRESOLVABLE_OWNER] : undefined,
    ownerNames: ownerNames.length > 0 ? ownerNames : undefined,
    ownerEmails: ownerEmails.length > 0 ? ownerEmails : undefined,
    notesLimit,
  };
}

/**
 * What counts as "a note this person logged".
 *
 * `type = 'note'` and nothing else, matching Rep Activity (reports/service.ts) and the Daily Activity Log.
 * The alternative — counting every activity row — would be wrong twice over. It would silently include the
 * `email` activities the Outlook sync mints per synced message, which are machine-generated rather than
 * logged by anyone, and would swamp the number. And it would put synced mailbox SUBJECT and BODY into this
 * report's feed, which is a different privacy question from the one this report was scoped to answer; the
 * Daily Activity Log gates that content behind an admin/director check for exactly that reason.
 */
export const NOTES_ONLY = sql`a.responsible_user_id IS NOT NULL AND a.type = 'note'`;

/**
 * A date-only column, as a plain YYYY-MM-DD string.
 *
 * Every `::date` selected by this service is cast `::text` in SQL rather than trusted to arrive as a
 * string, because it does NOT arrive as one in production: node-postgres registers a parser for type 1082
 * that returns a JS `Date`, so `String(row.bucket_start)` would read "Sun May 31" and every downstream
 * split on "-" would produce NaN. This is invisible under test — drizzle's PGlite driver overrides the DATE
 * parser to pass the raw string through — which is exactly why the cast belongs in the query and not in a
 * defensive JS branch. This helper is the second line of defence for anything that slips past.
 */
export function asIsoDate(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

/**
 * The bucket expression, in business time.
 *
 * `tsExpr` is emitted as RAW sql (it names a column), so it must never carry caller input — every call
 * site below passes a literal column reference.
 */
export function bucketSql(bucket: CanvassingBucket, tsExpr: string): SQL {
  if (bucket === "week") return sundayWeekBucketSql(tsExpr);
  const unit = bucket === "month" ? "month" : "quarter";
  return sql.raw(`(date_trunc('${unit}', ((${tsExpr}) AT TIME ZONE '${BUSINESS_TIMEZONE}')))::date`);
}

/** Business-tz calendar date of a timestamptz column. For SELECT/GROUP BY only — never for a WHERE. */
function businessDateSql(tsExpr: string): SQL {
  return sql.raw(`(((${tsExpr}) AT TIME ZONE '${BUSINESS_TIMEZONE}')::date)`);
}

/**
 * The date window, as a half-open range ON THE COLUMN ITSELF.
 *
 * Deliberately NOT `businessDateSql(col) BETWEEN from AND to`, which is what this used to be. That wraps the
 * column in a function, so it is not sargable and no index on created_at can narrow it — every request read
 * all four tables end to end no matter how short the window. `[from 00:00 business, to+1 00:00 business)`
 * selects exactly the same rows while leaving the column bare, so the plain created_at indexes from
 * migration 0220 can actually be used. Half-open, so the last day is whole and no row is double-counted.
 */
export function businessWindowSql(tsExpr: string, from: string, to: string): SQL {
  const col = sql.raw(`(${tsExpr})`);
  return sql`${col} >= (${from}::date AT TIME ZONE ${BUSINESS_TIMEZONE})
         AND ${col} < ((${to}::date + 1) AT TIME ZONE ${BUSINESS_TIMEZONE})`;
}

/** The last date any of this code will represent. Postgres dates go further; a 4-digit ISO string does not. */
const MAX_ISO_DATE = "9999-12-31";

/**
 * The exclusive end of the calendar period beginning at `start`, clamped to the representable domain.
 *
 * Clamped HERE rather than at each call site: guarding only the enumeration loop last round left this
 * helper still handing "10000-01-01" to isPartialBucket and shiftBusinessDate, which is the same
 * fix-the-instance-not-the-class mistake one layer down.
 */
function bucketEndExclusive(bucket: CanvassingBucket, start: string): string {
  if (bucket === "week") {
    const end = shiftBusinessDate(start, 7);
    // Checked by SHAPE, not by comparison: past year 9999 JS switches to the extended form "+010000-01-08",
    // and "+0..." sorts BELOW "9999-12-31" as a string, so `end > MAX_ISO_DATE` silently let it through.
    return ISO_DATE.test(end) && end <= MAX_ISO_DATE ? end : MAX_ISO_DATE;
  }
  const [y, m] = start.split("-").map(Number);
  const raw = m - 1 + (bucket === "month" ? 1 : 3);
  const year = y + Math.floor(raw / 12);
  if (year > 9999) return MAX_ISO_DATE;
  return `${String(year).padStart(4, "0")}-${String((raw % 12) + 1).padStart(2, "0")}-01`;
}

/** Whether the requested range clips this calendar period at either end. */
function isPartialBucket(bucket: CanvassingBucket, start: string, from: string, to: string): boolean {
  const endExclusive = bucketEndExclusive(bucket, start);
  const lastDay = shiftBusinessDate(endExclusive, -1);
  return start < from || lastDay > to;
}

export function labelForBucket(bucket: CanvassingBucket, startIso: string): string {
  const [y, m, d] = startIso.split("-").map(Number);
  // Never throw here. Intl.format on an Invalid Date raises a RangeError, which would turn one unexpected
  // value into a 500 for the whole report; showing the raw bucket key instead degrades one label.
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return startIso;
  // setUTCFullYear after construction: Date.UTC maps years 0-99 onto 1900-1999, so a bucket starting in
  // year 0042 formatted as 1942 across every label and both period tables.
  const start = new Date(Date.UTC(2000, (m ?? 1) - 1, d ?? 1));
  start.setUTCFullYear(y);
  if (Number.isNaN(start.getTime())) return startIso;
  if (bucket === "month") {
    return new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" }).format(start);
  }
  if (bucket === "quarter") {
    return `Q${Math.floor((start.getUTCMonth()) / 3) + 1} ${start.getUTCFullYear()}`;
  }
  const end = new Date(start.getTime() + 6 * 24 * 60 * 60 * 1000);
  const fmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  // The year is carried on the week label too. Without it a range crossing a year boundary renders two
  // columns reading "Jan 5 – Jan 11", indistinguishable in the chart and both period tables. The export
  // headers were given the year two rounds ago; the on-screen labels were left behind.
  // Both years when the week straddles New Year: "Dec 28 – Jan 3, 2025" reads as though Jan 3 is in 2025.
  return start.getUTCFullYear() === end.getUTCFullYear()
    ? `${fmt.format(start)} – ${fmt.format(end)}, ${start.getUTCFullYear()}`
    : `${fmt.format(start)}, ${start.getUTCFullYear()} – ${fmt.format(end)}, ${end.getUTCFullYear()}`;
}

/**
 * The four directory tables as one stream of (kind, creator, created_at).
 *
 * A UNION beats four separate queries here for a reason beyond round trips: it makes it impossible for the
 * window, the test-data rule or the active rule to drift between entity types, which is exactly how the
 * reports in this repo have historically ended up disagreeing with each other.
 */
/**
 * The row source for ONE kind: its table, its creator join, and every rule that decides whether a row
 * counts. Both the aggregate below and the drill-down in canvassing-evidence-service.ts build on this, so
 * a drill can never disagree with the number it was opened from — the alternative is two hand-written
 * predicates that agree until someone edits one.
 */
export function canvassingKindSourceSql(
  kind: CanvassingKind,
  filters: Pick<CanvassingActivityFilters, "dateFrom" | "dateTo">
): { table: string; alias: string; where: SQL } {
  const window = (alias: string) => businessWindowSql(`${alias}.created_at`, filters.dateFrom, filters.dateTo);
  // The creator is LEFT-joined and filtered on the USER's test flag as well as the row's. Filtering only the
  // row let a user marked is_test_data create ordinary-looking records and appear on the scoreboard, which
  // contradicts this file's own "test data excluded" rule and inflates the totals. LEFT, not INNER, because
  // a null creator is the unattributed case this report reports on rather than discards.
  const notATestUser = (alias: string) =>
    sql`(${sql.raw(alias)}.id IS NULL OR COALESCE(${sql.raw(alias)}.is_test_data, false) = false)`;

  const spec = {
    company: { table: "companies", alias: "c", user: "cu" },
    property: { table: "properties", alias: "p", user: "pu" },
    contact: { table: "contacts", alias: "ct", user: "ctu" },
    lead: { table: "leads", alias: "l", user: "lu" },
  }[kind];

  // Terminal statuses are OUTCOMES, not deletions. Converting a lead sets is_active=false while keeping
  // status='converted', and updateLead does the same for 'disqualified'. Counting on is_active alone docked
  // a canvasser both for succeeding and for turning up a lead that did not qualify — the work was done in
  // both cases, and 155 of the 209 leads in office_dallas are converted+inactive, so it hid most of the
  // column. Only a lead soft-deleted while still OPEN is excluded.
  //
  // Residual, stated rather than hidden: a converted lead that is LATER soft-deleted is indistinguishable
  // from a live one here, because the model overloads is_active for both meanings.
  const alive =
    kind === "lead"
      ? sql`(${sql.raw(spec.alias)}.is_active = true OR ${sql.raw(spec.alias)}.status IN ('converted', 'disqualified'))`
      : sql`${sql.raw(spec.alias)}.is_active = true`;

  return {
    table: spec.table,
    alias: spec.alias,
    where: sql`${alive}
       AND COALESCE(${sql.raw(spec.alias)}.is_test_data, false) = false
       AND ${notATestUser(spec.user)}
       AND ${window(spec.alias)}`,
  };
}

/** The creator join for a kind's row source, matching canvassingKindSourceSql's aliases. */
export function canvassingKindJoinSql(kind: CanvassingKind): SQL {
  const spec = { company: ["companies", "c", "cu"], property: ["properties", "p", "pu"], contact: ["contacts", "ct", "ctu"], lead: ["leads", "l", "lu"] }[kind];
  return sql.raw(`FROM ${spec[0]} ${spec[1]} LEFT JOIN users ${spec[2]} ON ${spec[2]}.id = ${spec[1]}.created_by_user_id`);
}

function createdStreamSql(filters: CanvassingActivityFilters): SQL {
  const parts = CANVASSING_KINDS.map((kind) => {
    const source = canvassingKindSourceSql(kind, filters);
    return sql`
      SELECT ${sql.raw(`'${kind}'`)}::text AS kind,
             ${sql.raw(source.alias)}.created_by_user_id AS user_id,
             ${sql.raw(source.alias)}.created_at
        ${canvassingKindJoinSql(kind)}
       WHERE ${source.where}`;
  });
  return sql.join(parts, sql` UNION ALL `);
}

/**
 * Fold `ownerNames` / `ownerEmails` into `userIds`.
 *
 * The filter bar writes all three forms and resolves names locally, so a URL carrying `?owners=Jane` shows
 * Jane ticked while the report — which only ever read ids — stayed office-wide until Apply was pressed. The
 * lookup is bounded to this office for the same reason the roster lookup is: `users` is global, and
 * resolving an arbitrary name must not become a way to test who exists elsewhere.
 */
async function resolveOwnerSelection(
  tenantDb: TenantDb,
  filters: CanvassingActivityFilters
): Promise<CanvassingActivityFilters> {
  const names = filters.ownerNames ?? [];
  const emails = filters.ownerEmails ?? [];
  if (names.length === 0 && emails.length === 0) return filters;
  // Explicit ids win outright. The filter bar sends ownerIds, owners AND ownerEmails together, so when two
  // office members share a display name, unioning the name matches would widen a deliberate selection of
  // one of them to both — the id says which one was actually clicked.
  if ((filters.userIds?.length ?? 0) > 0) return filters;

  const membership = filters.officeId
    ? sql`(u.office_id = ${filters.officeId} OR EXISTS (
        SELECT 1 FROM user_office_access uo WHERE uo.user_id = u.id AND uo.office_id = ${filters.officeId}
      ))`
    : sql`TRUE`;
  const matchers: SQL[] = [];
  if (names.length) {
    matchers.push(sql`LOWER(u.display_name) = ANY(${sql`ARRAY[${sql.join(names.map((n) => sql`${n.toLowerCase()}`), sql`, `)}]`})`);
  }
  if (emails.length) {
    matchers.push(sql`LOWER(u.email) = ANY(${sql`ARRAY[${sql.join(emails.map((e) => sql`${e.toLowerCase()}`), sql`, `)}]`})`);
  }

  const rows = await tenantDb.execute<{ id: string }>(sql`
    SELECT u.id::text AS id FROM users u
     WHERE (${sql.join(matchers, sql` OR `)}) AND ${membership}
  `);
  const resolved = rows.rows.map((row) => row.id);
  // An owner selector that resolves to NOBODY is still a selector. Returning the filters untouched left
  // userIds empty, which every downstream reader takes as "no person filter" — so a stale ?owners=Jane link
  // for someone who has left the office silently showed the ENTIRE office under Jane's name. A sentinel id
  // keeps it a filter that simply matches nothing.
  return { ...filters, userIds: resolved.length > 0 ? resolved : [UNRESOLVABLE_OWNER] };
}

export async function getCanvassingActivityReport(
  tenantDb: TenantDb,
  input: CanvassingActivityFilters
): Promise<CanvassingActivityReport> {
  const filters = await resolveOwnerSelection(tenantDb, input);
  const stream = createdStreamSql(filters);
  const bucketExpr = bucketSql(filters.bucket, "s.created_at");

  // One pass over the union, grouped by bucket + creator + kind. Null creators fall into the same rows and
  // are separated in JS, so attributed and unattributed can never be windowed differently.
  const gridRows = await tenantDb.execute<{
    bucket_start: string;
    user_id: string | null;
    kind: CanvassingKind;
    n: number;
  }>(sql`
    WITH s AS (${stream})
    SELECT ${bucketExpr}::text AS bucket_start,
           s.user_id::text AS user_id,
           s.kind AS kind,
           COUNT(*)::int AS n
      FROM s
     GROUP BY 1, 2, 3
     ORDER BY 1
  `);

  // Notes logged per person in the window, attributed and TYPED the way Rep Activity and the Daily Activity
  // Log do it, so "notes logged" means the same thing on all three surfaces.
  const noteCountRows = await tenantDb.execute<{ bucket_start: string; user_id: string; n: number }>(sql`
    SELECT ${bucketSql(filters.bucket, "a.occurred_at")}::text AS bucket_start,
           a.responsible_user_id::text AS user_id,
           COUNT(*)::int AS n
      FROM activities a
      JOIN users u ON u.id = a.responsible_user_id
     WHERE ${NOTES_ONLY}
       AND COALESCE(u.is_test_data, false) = false
       -- A REAL user logging against a TEST record is still test activity. Every other query filters test
       -- data on the row itself; these filtered only the author, so QA work reached both the count and the
       -- feed while the records it was about were excluded from the counts beside it.
       -- The PERFORMER as well as the responsible user: a test admin logging on a real rep's behalf stores
       -- the rep as responsible and the test account as performer, so filtering the responsible user alone
       -- let QA activity through under a real person's name.
       AND NOT EXISTS (
         SELECT 1 FROM users pfu WHERE pfu.id = a.performed_by_user_id AND pfu.is_test_data = true
       )
       AND NOT EXISTS (SELECT 1 FROM companies tc WHERE tc.id = a.company_id AND tc.is_test_data = true)
       AND NOT EXISTS (SELECT 1 FROM properties tp WHERE tp.id = a.property_id AND tp.is_test_data = true)
       AND NOT EXISTS (SELECT 1 FROM contacts tct WHERE tct.id = a.contact_id AND tct.is_test_data = true)
       AND NOT EXISTS (SELECT 1 FROM leads tl WHERE tl.id = a.lead_id AND tl.is_test_data = true)
       AND NOT EXISTS (SELECT 1 FROM deals td WHERE td.id = a.deal_id AND td.is_test_data = true)
       AND ${businessWindowSql("a.occurred_at", filters.dateFrom, filters.dateTo)}
     GROUP BY 1, 2
  `);

  const requested = filters.userIds ?? [];
  const dataUserIds = new Set<string>();
  for (const row of gridRows.rows) if (row.user_id) dataUserIds.add(row.user_id);
  for (const row of noteCountRows.rows) if (row.user_id) dataUserIds.add(row.user_id);
  const seenUserIds = new Set<string>([...dataUserIds, ...requested]);

  // Two classes of id reach this lookup, and they get different treatment.
  //
  // Ids DISCOVERED IN THE DATA are safe to resolve unconditionally: the rows are in this office's schema,
  // so whoever created them is already this tenant's business, even if their office membership has since
  // moved. Ids the CALLER PINNED are not: `users` is one global table, so resolving an arbitrary uuid would
  // return that person's name, email, role and active flag from any office — a directory read dressed up as
  // a zero-count row. Those must prove membership of this office first, the same way the dashboard roster
  // does (office_id, or a user_office_access grant).
  // When the caller pinned a set of people, the whole report is about them: everyone else drops out of the
  // per-person and per-bucket breakdowns. The `unattributed` figures stay whole-office on purpose — they
  // describe what the DATA cannot attribute, which is not a property of the selected people.
  const pinned = requested.length > 0 ? new Set(requested) : null;

  const discovered = [...seenUserIds].filter((id) => !requested.includes(id) || dataUserIds.has(id));
  const pinnedOnly = [...seenUserIds].filter((id) => !discovered.includes(id));
  const idArray = (ids: string[]) => sql`ARRAY[${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)}]`;
  const membership = filters.officeId
    ? sql`(u.office_id = ${filters.officeId} OR EXISTS (
        SELECT 1 FROM user_office_access uo WHERE uo.user_id = u.id AND uo.office_id = ${filters.officeId}
      ))`
    : sql`TRUE`;

  // The EFFECTIVE role in the selected office, not the global one. `users` is a single global table and
  // user_office_access.role_override is what authMiddleware resolves a request's role from, so classifying
  // — or REPORTING — on users.role alone judges a multi-office person by whichever office they call home.
  // Used by both the predicate and the SELECT, so a person listed because of their override is not then
  // labelled with the role they do not hold here.
  //
  // The override is ignored for someone's OWN office, matching authMiddleware, which only consults
  // user_office_access when the requested office differs from users.office_id. A stray access row for a
  // home office must not change how this report classifies them when a live request would not.
  const effectiveRole = filters.officeId
    ? sql`CASE
            WHEN u.office_id = ${filters.officeId} THEN u.role
            ELSE COALESCE((
              SELECT uo.role_override FROM user_office_access uo
               WHERE uo.user_id = u.id AND uo.office_id = ${filters.officeId}
                 AND uo.role_override IS NOT NULL
               LIMIT 1
            ), u.role)
          END`
    : sql`u.role`;

  const rosterPredicates: SQL[] = [];
  if (discovered.length) {
    // Discovered ids are resolved on the reasoning that their rows live in THIS schema, so whoever is named
    // is already this tenant's business. That holds for created_by_user_id, which only a session can write
    // — but activities.responsible_user_id is POSTED, so an elevated caller can name an account from
    // another office and have it surface here. They prove membership too.
    rosterPredicates.push(
      sql`(u.id = ANY(${idArray(discovered)}) AND COALESCE(u.is_test_data, false) = false AND ${membership})`
    );
  }
  if (pinnedOnly.length) {
    // Test users are excluded here too. Every counting query filters them and the default roster filters
    // them; leaving the pinned path open let a QA account be selected onto the scoreboard by id.
    rosterPredicates.push(
      sql`(u.id = ANY(${idArray(pinnedOnly)}) AND COALESCE(u.is_test_data, false) = false AND ${membership})`
    );
  }
  // UNFILTERED, the roster is everyone who is SUPPOSED to be canvassing, not merely everyone who did.
  //
  // Building it only from people with activity meant someone who canvassed nothing all week vanished from
  // the report instead of showing the zero this whole surface exists to make visible — you cannot notice an
  // absence that is not drawn. But "every active office member" is the wrong widening: it would list
  // admins, estimators and construction staff at zero forever and bury the handful the report is about.
  // `generates_sales` already answers exactly this question ("is this person expected to produce sales
  // activity", migration 0219), so the default roster is the office's sales carriers — 10 people, not 40.
  // A pinned selection overrides it, because then the caller has said who they want.
  if (!pinned) {
    // ROLE, not the deal-carrier flag. An earlier revision used users.generates_sales, but that flag means
    // "appears on the director dashboard's rep performance views" — unticking someone there is a deliberate
    // statement about THAT surface, and borrowing it here made an active canvasser disappear from this
    // report because of a decision taken about a different one. Role is the stable answer to "is this
    // person client-facing", and it covers a canvassing director (Chris) as well as the reps.
    //
    // Test users are excluded here as well as in the counting queries — otherwise a QA account would be
    // drawn onto the scoreboard as a permanent zero row.
    rosterPredicates.push(
      sql`(u.is_active = true AND ${effectiveRole} IN ('rep', 'director')
           AND COALESCE(u.is_test_data, false) = false AND ${membership})`
    );
  }

  const rosterRows = rosterPredicates.length
    ? await tenantDb.execute<{
        id: string;
        display_name: string;
        email: string | null;
        role: string | null;
        is_active: boolean;
      }>(sql`
        SELECT u.id::text AS id, u.display_name, u.email, ${effectiveRole}::text AS role, u.is_active
          FROM users u
         WHERE ${sql.join(rosterPredicates, sql` OR `)}
      `)
    : { rows: [] as Array<{ id: string; display_name: string; email: string | null; role: string | null; is_active: boolean }> };

  const roster = new Map(rosterRows.rows.map((row) => [row.id, row]));

  const includeUser = (userId: string) => (pinned ? pinned.has(userId) : true);

  const totals = zeroCounts();
  const unattributed = zeroCounts();
  const perPersonCounts = new Map<string, CanvassingCounts>();
  const bucketMap = new Map<string, CanvassingBucketRow>();

  const ensureBucket = (start: string): CanvassingBucketRow => {
    let row = bucketMap.get(start);
    if (!row) {
      row = {
        bucketStart: start,
        label: labelForBucket(filters.bucket, start),
        partial: isPartialBucket(filters.bucket, start, filters.dateFrom, filters.dateTo),
        counts: zeroCounts(),
        unattributed: zeroCounts(),
        perUser: [],
      };
      bucketMap.set(start, row);
    }
    return row;
  };
  const bucketUser = new Map<string, Map<string, { counts: CanvassingCounts; notesLogged: number }>>();

  for (const row of gridRows.rows) {
    const start = asIsoDate(row.bucket_start);

    if (!row.user_id) {
      const bucketRow = ensureBucket(start);
      addTo(unattributed, row.kind, row.n);
      addTo(bucketRow.unattributed, row.kind, row.n);
      continue;
    }
    // Deliberately AFTER the include check: a bucket whose only rows belong to people the caller did not
    // pin would otherwise render as a row of zeros, which reads as "a quiet week" rather than "not asked".
    if (!includeUser(row.user_id)) continue;
    const bucketRow = ensureBucket(start);

    addTo(totals, row.kind, row.n);
    addTo(bucketRow.counts, row.kind, row.n);

    let person = perPersonCounts.get(row.user_id);
    if (!person) {
      person = zeroCounts();
      perPersonCounts.set(row.user_id, person);
    }
    addTo(person, row.kind, row.n);

    let inBucket = bucketUser.get(start);
    if (!inBucket) {
      inBucket = new Map();
      bucketUser.set(start, inBucket);
    }
    let cell = inBucket.get(row.user_id);
    if (!cell) {
      cell = { counts: zeroCounts(), notesLogged: 0 };
      inBucket.set(row.user_id, cell);
    }
    addTo(cell.counts, row.kind, row.n);
  }

  let notesLogged = 0;
  const perPersonNotes = new Map<string, number>();
  for (const row of noteCountRows.rows) {
    if (!row.user_id || !includeUser(row.user_id)) continue;
    const start = asIsoDate(row.bucket_start);
    ensureBucket(start);
    notesLogged += row.n;
    perPersonNotes.set(row.user_id, (perPersonNotes.get(row.user_id) ?? 0) + row.n);

    let inBucket = bucketUser.get(start);
    if (!inBucket) {
      inBucket = new Map();
      bucketUser.set(start, inBucket);
    }
    const cell = inBucket.get(row.user_id) ?? { counts: zeroCounts(), notesLogged: 0 };
    cell.notesLogged += row.n;
    inBucket.set(row.user_id, cell);
  }

  for (const [start, users] of bucketUser) {
    const bucketRow = ensureBucket(start);
    bucketRow.perUser = [...users].map(([userId, cell]) => ({ userId, ...cell }));
  }

  // Pinned people who did nothing still get a row. That zero is the finding.
  const peopleIds = new Set([
    ...perPersonCounts.keys(),
    ...perPersonNotes.keys(),
    ...(pinned ?? []),
    // The sales carriers the roster query returned, so a zero week is a visible row rather than an absence.
    ...(pinned ? [] : rosterRows.rows.map((row) => row.id)),
  ]);
  const people: CanvassingPersonRow[] = [...peopleIds]
    // A pinned id the roster refused (not a member of this office) is dropped outright. Printing it as an
    // "Unknown user" zero row would still confirm the uuid resolves to somebody.
    .filter((userId) => roster.has(userId) || dataUserIds.has(userId))
    .map((userId) => {
      const user = roster.get(userId);
      return {
        userId,
        displayName: user?.display_name ?? "Unknown user",
        email: user?.email ?? null,
        role: user?.role ?? null,
        isActive: user?.is_active ?? false,
        counts: perPersonCounts.get(userId) ?? zeroCounts(),
        notesLogged: perPersonNotes.get(userId) ?? 0,
      };
    })
    .sort((a, b) => b.counts.total - a.counts.total || a.displayName.localeCompare(b.displayName));

  const notes = await loadNotes(tenantDb, filters, pinned);
  const attributionStartHint = await loadAttributionStart(tenantDb);

  // Every calendar period in the range gets a row, present or not. A silently-missing week is the one thing
  // this report must not do: it renders weeks 1 and 3 side by side and the quiet week in between disappears,
  // which is the opposite of an accountability view.
  for (const start of bucketStartsInRange(filters.bucket, filters.dateFrom, filters.dateTo)) ensureBucket(start);

  return {
    range: { from: filters.dateFrom, to: filters.dateTo },
    rangeClamped: filters.rangeClamped === true,
    bucket: filters.bucket,
    totals,
    unattributed,
    notesLogged,
    people,
    buckets: [...bucketMap.values()].sort((a, b) => a.bucketStart.localeCompare(b.bucketStart)),
    notes: notes.rows,
    notesTruncated: notes.truncated,
    notesRestrictedToSelf: notes.restrictedToSelf,
    attributionStartHint,
  };
}

/**
 * The readable feed: what these people actually wrote, in the style of the Daily Activity Log.
 *
 * Fetches limit+1 so `notesTruncated` is a fact rather than a guess — a feed that silently stops at 200
 * reads as "that was everything".
 */
async function loadNotes(
  tenantDb: TenantDb,
  filters: CanvassingActivityFilters,
  pinned: Set<string> | null
): Promise<{ rows: CanvassingNoteRow[]; truncated: boolean; restrictedToSelf: boolean }> {
  const limit = filters.notesLimit ?? DEFAULT_NOTES_LIMIT;
  // WHO MAY I SEE, intersected with WHO WAS ASKED FOR. Stated as two sets rather than a chain of
  // conditionals, because three successive rounds of patching this rule each introduced a new hole: it
  // failed open when the id was missing, it read the per-office role instead of the home one, and it
  // REPLACED the pinned selection rather than intersecting it — so a rep filtering to a colleague got that
  // colleague's counts beside their own notes, two scopes in one view.
  //
  // A `rep` reads only their own notes, even on the allowlist: GET /activities pins an unscoped rep to their
  // own rows and the Daily Activity Log does the same, and a new report is not a way around that. The COUNTS
  // stay office-wide on purpose — "Caleb logged 12 notes" is the accountability figure, and it is a
  // different disclosure from the text of what he wrote.
  const restrictToSelf = filters.viewerRole === "rep" || filters.viewerEffectiveRole === "rep";
  // null means "no restriction from this side"; an EMPTY set means "restricted to nobody", which must
  // return nothing rather than falling through to everything.
  const maySee: Set<string> | null = restrictToSelf
    ? new Set(filters.viewerUserId ? [filters.viewerUserId] : [])
    : null;

  let visible: Set<string> | null;
  if (maySee && pinned) visible = new Set([...pinned].filter((id) => maySee.has(id)));
  else visible = maySee ?? pinned;

  if (visible && visible.size === 0) return { rows: [], truncated: false, restrictedToSelf: restrictToSelf };
  const userFilter = visible
    ? sql`AND a.responsible_user_id = ANY(${sql`ARRAY[${sql.join([...visible].map((id) => sql`${id}::uuid`), sql`, `)}]`})`
    : sql``;

  const result = await tenantDb.execute<{
    id: string;
    type: string;
    subject: string | null;
    body: string | null;
    occurred_at: string;
    user_id: string | null;
    user_name: string | null;
    performed_by_name: string | null;
    target_type: CanvassingNoteRow["targetType"];
    target_id: string | null;
    target_name: string | null;
  }>(sql`
    SELECT a.id::text AS id,
           a.type::text AS type,
           a.subject,
           a.body,
           a.occurred_at,
           a.responsible_user_id::text AS user_id,
           u.display_name AS user_name,
           -- Attribution stays on responsible_user_id so "notes logged" reconciles with Rep Activity and
           -- the Daily Activity Log. But an admin can log on someone's behalf and a workflow can mint a
           -- note during a stage change, so the row carries who ACTUALLY did it when that differs -- the
           -- same "on behalf of" marker the Daily Activity Log shows.
           CASE WHEN a.performed_by_user_id IS NOT NULL AND a.performed_by_user_id <> a.responsible_user_id
                THEN pu.display_name END AS performed_by_name,
           -- Precedence deliberately matches the Daily Activity Log (deal > contact > company > lead >
           -- property), because activities routinely carry SEVERAL of these at once: the Outlook sync writes
           -- companyId, propertyId, leadId AND dealId on one row. A different order here would label the
           -- same activity "on <Company>" while the neighbouring report labels it "on <Deal>".
           CASE
             WHEN a.deal_id     IS NOT NULL THEN 'deal'
             WHEN a.contact_id  IS NOT NULL THEN 'contact'
             WHEN a.company_id  IS NOT NULL THEN 'company'
             WHEN a.lead_id     IS NOT NULL THEN 'lead'
             WHEN a.property_id IS NOT NULL THEN 'property'
           END AS target_type,
           COALESCE(a.deal_id, a.contact_id, a.company_id, a.lead_id, a.property_id)::text AS target_id,
           COALESCE(
             de.name,
             NULLIF(BTRIM(CONCAT_WS(' ', ct.first_name, ct.last_name)), ''),
             co.name,
             le.name,
             pr.name
           ) AS target_name
      FROM activities a
      JOIN users u           ON u.id  = a.responsible_user_id
      LEFT JOIN users pu     ON pu.id = a.performed_by_user_id
      LEFT JOIN companies co ON co.id = a.company_id
      LEFT JOIN properties pr ON pr.id = a.property_id
      LEFT JOIN contacts ct  ON ct.id = a.contact_id
      LEFT JOIN leads le     ON le.id = a.lead_id
      LEFT JOIN deals de     ON de.id = a.deal_id
     WHERE ${NOTES_ONLY}
       AND COALESCE(u.is_test_data, false) = false
       -- The PERFORMER as well as the responsible user: a test admin logging on a real rep's behalf stores
       -- the rep as responsible and the test account as performer, so filtering the responsible user alone
       -- let QA activity through under a real person's name.
       AND NOT EXISTS (
         SELECT 1 FROM users pfu WHERE pfu.id = a.performed_by_user_id AND pfu.is_test_data = true
       )
       AND NOT EXISTS (SELECT 1 FROM companies tc WHERE tc.id = a.company_id AND tc.is_test_data = true)
       AND NOT EXISTS (SELECT 1 FROM properties tp WHERE tp.id = a.property_id AND tp.is_test_data = true)
       AND NOT EXISTS (SELECT 1 FROM contacts tct WHERE tct.id = a.contact_id AND tct.is_test_data = true)
       AND NOT EXISTS (SELECT 1 FROM leads tl WHERE tl.id = a.lead_id AND tl.is_test_data = true)
       AND NOT EXISTS (SELECT 1 FROM deals td WHERE td.id = a.deal_id AND td.is_test_data = true)
       AND ${businessWindowSql("a.occurred_at", filters.dateFrom, filters.dateTo)}
       ${userFilter}
     ORDER BY a.occurred_at DESC, a.id DESC
     LIMIT ${limit + 1}
  `);

  const truncated = result.rows.length > limit;
  const rows = (truncated ? result.rows.slice(0, limit) : result.rows).map((row) => ({
    id: row.id,
    type: row.type,
    subject: row.subject,
    body: row.body,
    occurredAt: typeof row.occurred_at === "string" ? row.occurred_at : new Date(row.occurred_at).toISOString(),
    userId: row.user_id,
    userName: row.user_name,
    performedByName: row.performed_by_name,
    targetType: row.target_type,
    targetId: row.target_id,
    targetName: row.target_name,
  }));

  return { rows, truncated, restrictedToSelf: restrictToSelf };
}

/**
 * The date this report becomes trustworthy: the earliest attributed creation among the three tables that
 * migration 0220 introduced.
 *
 * `leads` is deliberately EXCLUDED from this minimum even though it is counted in the report. It has carried
 * created_by_user_id since migration 0128, so in any office holding an older attributed lead a MIN across
 * all four would return that older date — and the banner would claim creator tracking began then, while
 * companies, properties and contacts were still structurally unattributed. That reads their zeros as
 * meaningful when they are not. The binding constraint is the LATEST of the four onsets, not the earliest,
 * and for the three that share 0220 it is simply the first record any of them attributed.
 */
async function loadAttributionStart(tenantDb: TenantDb): Promise<string | null> {
  // MIN over the BARE column, so the partial (created_at WHERE created_by_user_id IS NOT NULL) indexes from
  // migration 0220 can serve it as an indexed min instead of a full history scan on every request. The
  // business-tz conversion happens once, here, rather than per row inside the aggregate.
  const result = await tenantDb.execute<{ started: string | Date | null }>(sql`
    SELECT MIN(started) AS started FROM (
      SELECT MIN(c.created_at) AS started FROM companies c WHERE c.created_by_user_id IS NOT NULL
      UNION ALL
      SELECT MIN(p.created_at) FROM properties p WHERE p.created_by_user_id IS NOT NULL
      UNION ALL
      SELECT MIN(ct.created_at) FROM contacts ct WHERE ct.created_by_user_id IS NOT NULL
    ) firsts
  `);
  const value = result.rows[0]?.started ?? null;
  if (!value) return null;
  const at = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(at.getTime())) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: BUSINESS_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}
