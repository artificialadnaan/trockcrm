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
// ACTIVE ONLY. Soft-deleted rows do not count. Canvassing credit should not survive the cleanup of a
// duplicate someone entered twice, and the reports suite already treats is_active=true as the population.
// The consequence, stated because it is surprising: a past week's number can go DOWN if a record entered
// then is deactivated later. That is the intended direction -- the alternative pays for duplicates.
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
   * The office this request is scoped to. `users` is a single GLOBAL table, so without it a crafted
   * ?userIds=<uuid> for an account in another office would be looked up and its name, email, role and
   * active flag returned as a zero-count row — reading the global directory through a tenant report.
   */
  officeId?: string | null;
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
  targetType: "company" | "property" | "contact" | "lead" | "deal" | null;
  targetId: string | null;
  targetName: string | null;
}

export interface CanvassingActivityReport {
  range: { from: string; to: string };
  bucket: CanvassingBucket;
  totals: CanvassingCounts;
  unattributed: CanvassingCounts;
  notesLogged: number;
  people: CanvassingPersonRow[];
  buckets: CanvassingBucketRow[];
  notes: CanvassingNoteRow[];
  notesTruncated: boolean;
  /**
   * Earliest attributed creation in this office, or null if nothing has ever been attributed. The client
   * prints "attribution starts <date>" so a zero before that date is not misread as inactivity.
   */
  attributionStartHint: string | null;
}

const DEFAULT_NOTES_LIMIT = 200;
const MAX_NOTES_LIMIT = 500;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A date that is both ISO-SHAPED and real.
 *
 * The shape test alone accepts "2026-13-45" and "2026-02-30", which Postgres then rejects with
 * "date/time field value out of range" — turning a stale bookmark into a 500, the exact opposite of what
 * this normalizer promises. Round-tripping through Date catches both the out-of-range month/day and the
 * silently-rolled-over ones (Feb 30 -> Mar 2).
 */
function isRealIsoDate(value: string): boolean {
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
  const next = (iso: string): string => {
    if (bucket === "week") return shiftBusinessDate(iso, 7);
    const [y, m] = iso.split("-").map(Number);
    const step = bucket === "month" ? 1 : 3;
    const raw = m - 1 + step;
    return `${String(y + Math.floor(raw / 12)).padStart(4, "0")}-${String((raw % 12) + 1).padStart(2, "0")}-01`;
  };

  const out: string[] = [];
  // Bounded independently of the loop body: a malformed range must not be able to spin here.
  for (let cursor = startOf(from); cursor <= to && out.length < 1024; cursor = next(cursor)) out.push(cursor);
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

  const userIds = pick(query.userIds)
    .split(",")
    .map((value) => value.trim())
    .filter((value) => UUID.test(value));

  const limitRaw = Number(pick(query.notesLimit));
  const notesLimit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), MAX_NOTES_LIMIT) : DEFAULT_NOTES_LIMIT;

  return { dateFrom: from, dateTo: to, bucket, userIds: userIds.length > 0 ? userIds : undefined, notesLimit };
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
const NOTES_ONLY = sql`a.responsible_user_id IS NOT NULL AND a.type = 'note'`;

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
function bucketSql(bucket: CanvassingBucket, tsExpr: string): SQL {
  if (bucket === "week") return sundayWeekBucketSql(tsExpr);
  const unit = bucket === "month" ? "month" : "quarter";
  return sql.raw(`(date_trunc('${unit}', ((${tsExpr}) AT TIME ZONE '${BUSINESS_TIMEZONE}')))::date`);
}

/** Business-tz calendar date of a timestamptz column, for windowing. */
function businessDateSql(tsExpr: string): SQL {
  return sql.raw(`(((${tsExpr}) AT TIME ZONE '${BUSINESS_TIMEZONE}')::date)`);
}

export function labelForBucket(bucket: CanvassingBucket, startIso: string): string {
  const [y, m, d] = startIso.split("-").map(Number);
  // Never throw here. Intl.format on an Invalid Date raises a RangeError, which would turn one unexpected
  // value into a 500 for the whole report; showing the raw bucket key instead degrades one label.
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return startIso;
  const start = new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1));
  if (Number.isNaN(start.getTime())) return startIso;
  if (bucket === "month") {
    return new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" }).format(start);
  }
  if (bucket === "quarter") {
    return `Q${Math.floor((start.getUTCMonth()) / 3) + 1} ${start.getUTCFullYear()}`;
  }
  const end = new Date(start.getTime() + 6 * 24 * 60 * 60 * 1000);
  const fmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return `${fmt.format(start)} – ${fmt.format(end)}`;
}

/**
 * The four directory tables as one stream of (kind, creator, created_at).
 *
 * A UNION beats four separate queries here for a reason beyond round trips: it makes it impossible for the
 * window, the test-data rule or the active rule to drift between entity types, which is exactly how the
 * reports in this repo have historically ended up disagreeing with each other.
 */
function createdStreamSql(filters: CanvassingActivityFilters): SQL {
  const from = filters.dateFrom;
  const to = filters.dateTo;
  const window = (alias: string) =>
    sql`${businessDateSql(`${alias}.created_at`)} BETWEEN ${from}::date AND ${to}::date`;

  // The creator is LEFT-joined and filtered on the USER's test flag as well as the row's. Filtering only the
  // row let a user marked is_test_data create ordinary-looking records and appear on the scoreboard, which
  // contradicts this file's own "test data excluded" rule and inflates the totals. LEFT, not INNER, because
  // a null creator is the unattributed case this report reports on rather than discards.
  const notATestUser = (alias: string) =>
    sql`(${sql.raw(alias)}.id IS NULL OR COALESCE(${sql.raw(alias)}.is_test_data, false) = false)`;

  return sql`
    SELECT 'company'::text AS kind, c.created_by_user_id AS user_id, c.created_at
      FROM companies c
      LEFT JOIN users cu ON cu.id = c.created_by_user_id
     WHERE c.is_active = true AND COALESCE(c.is_test_data, false) = false
       AND ${notATestUser("cu")} AND ${window("c")}
    UNION ALL
    SELECT 'property'::text, p.created_by_user_id, p.created_at
      FROM properties p
      LEFT JOIN users pu ON pu.id = p.created_by_user_id
     WHERE p.is_active = true AND COALESCE(p.is_test_data, false) = false
       AND ${notATestUser("pu")} AND ${window("p")}
    UNION ALL
    SELECT 'contact'::text, ct.created_by_user_id, ct.created_at
      FROM contacts ct
      LEFT JOIN users ctu ON ctu.id = ct.created_by_user_id
     WHERE ct.is_active = true AND COALESCE(ct.is_test_data, false) = false
       AND ${notATestUser("ctu")} AND ${window("ct")}
    UNION ALL
    SELECT 'lead'::text, l.created_by_user_id, l.created_at
      FROM leads l
      LEFT JOIN users lu ON lu.id = l.created_by_user_id
     WHERE l.is_active = true AND COALESCE(l.is_test_data, false) = false
       AND ${notATestUser("lu")} AND ${window("l")}
  `;
}

export async function getCanvassingActivityReport(
  tenantDb: TenantDb,
  filters: CanvassingActivityFilters
): Promise<CanvassingActivityReport> {
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
       AND ${businessDateSql("a.occurred_at")} BETWEEN ${filters.dateFrom}::date AND ${filters.dateTo}::date
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
  const discovered = [...seenUserIds].filter((id) => !requested.includes(id) || dataUserIds.has(id));
  const pinnedOnly = [...seenUserIds].filter((id) => !discovered.includes(id));
  const idArray = (ids: string[]) => sql`ARRAY[${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)}]`;
  const membership = filters.officeId
    ? sql`(u.office_id = ${filters.officeId} OR EXISTS (
        SELECT 1 FROM user_office_access uo WHERE uo.user_id = u.id AND uo.office_id = ${filters.officeId}
      ))`
    : sql`TRUE`;

  const rosterPredicates: SQL[] = [];
  if (discovered.length) rosterPredicates.push(sql`u.id = ANY(${idArray(discovered)})`);
  if (pinnedOnly.length) rosterPredicates.push(sql`(u.id = ANY(${idArray(pinnedOnly)}) AND ${membership})`);

  const rosterRows = rosterPredicates.length
    ? await tenantDb.execute<{
        id: string;
        display_name: string;
        email: string | null;
        role: string | null;
        is_active: boolean;
      }>(sql`
        SELECT u.id::text AS id, u.display_name, u.email, u.role::text AS role, u.is_active
          FROM users u
         WHERE ${sql.join(rosterPredicates, sql` OR `)}
      `)
    : { rows: [] as Array<{ id: string; display_name: string; email: string | null; role: string | null; is_active: boolean }> };

  const roster = new Map(rosterRows.rows.map((row) => [row.id, row]));

  // When the caller pinned a set of people, the whole report is about them: everyone else drops out of the
  // per-person and per-bucket breakdowns. The `unattributed` figures stay whole-office on purpose — they
  // describe what the DATA cannot attribute, which is not a property of the selected people.
  const pinned = requested.length > 0 ? new Set(requested) : null;
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
  const peopleIds = new Set([...perPersonCounts.keys(), ...perPersonNotes.keys(), ...(pinned ?? [])]);
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
    bucket: filters.bucket,
    totals,
    unattributed,
    notesLogged,
    people,
    buckets: [...bucketMap.values()].sort((a, b) => a.bucketStart.localeCompare(b.bucketStart)),
    notes: notes.rows,
    notesTruncated: notes.truncated,
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
): Promise<{ rows: CanvassingNoteRow[]; truncated: boolean }> {
  const limit = filters.notesLimit ?? DEFAULT_NOTES_LIMIT;
  const userFilter = pinned
    ? sql`AND a.responsible_user_id = ANY(${sql`ARRAY[${sql.join([...pinned].map((id) => sql`${id}::uuid`), sql`, `)}]`})`
    : sql``;

  const result = await tenantDb.execute<{
    id: string;
    type: string;
    subject: string | null;
    body: string | null;
    occurred_at: string;
    user_id: string | null;
    user_name: string | null;
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
      LEFT JOIN companies co ON co.id = a.company_id
      LEFT JOIN properties pr ON pr.id = a.property_id
      LEFT JOIN contacts ct  ON ct.id = a.contact_id
      LEFT JOIN leads le     ON le.id = a.lead_id
      LEFT JOIN deals de     ON de.id = a.deal_id
     WHERE ${NOTES_ONLY}
       AND COALESCE(u.is_test_data, false) = false
       AND ${businessDateSql("a.occurred_at")} BETWEEN ${filters.dateFrom}::date AND ${filters.dateTo}::date
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
    targetType: row.target_type,
    targetId: row.target_id,
    targetName: row.target_name,
  }));

  return { rows, truncated };
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
  const result = await tenantDb.execute<{ started: string | null }>(sql`
    SELECT MIN(started)::text AS started FROM (
      SELECT MIN(${businessDateSql("c.created_at")}) AS started FROM companies c WHERE c.created_by_user_id IS NOT NULL
      UNION ALL
      SELECT MIN(${businessDateSql("p.created_at")}) FROM properties p WHERE p.created_by_user_id IS NOT NULL
      UNION ALL
      SELECT MIN(${businessDateSql("ct.created_at")}) FROM contacts ct WHERE ct.created_by_user_id IS NOT NULL
    ) firsts
  `);
  const value = result.rows[0]?.started ?? null;
  return value ? String(value).slice(0, 10) : null;
}
