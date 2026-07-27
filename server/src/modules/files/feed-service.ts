import { eq, and, desc, gte, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { files, deals, users, dealCompanycamProjects } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import { AppError } from "../../middleware/error-handler.js";

type TenantDb = NodePgDatabase<typeof schema>;

/**
 * Where a photo came from. This is DERIVED, not stored: on a photo row `files.subcategory` only ever
 * holds 'CompanyCam' or NULL (prod census 2026-07-27: 19,734 'CompanyCam' vs 8,607 NULL + 3,280 with a
 * photo_category and no subcategory), so despite its name it is a SOURCE flag, not the phase dimension.
 * The phase dimension is `files.photo_category`. Exposing subcategory as "category" in the UI would
 * offer a dropdown with exactly one real option.
 */
export const PHOTO_FEED_SOURCES = ["companycam", "trock"] as const;

/**
 * A photo's PHASE, normalized across the two columns that carry it.
 *
 * `files.photo_category` is the typed column, but the CRM web capture flow still writes the phase the
 * user picked into `files.subcategory` — `photo-capture-page.tsx` says so in as many words ("The 6 phase
 * categories (shared source of truth). Stored on the `subcategory`"), and the deal photo timeline
 * already reads both (`photo-timeline-filters.ts`). Comparing only `photo_category` would mean a photo
 * captured through that flow is missing from its own phase AND wrongly counted as Uncategorized — the
 * same value meaning two different things on two surfaces, which is the class of bug this feed work
 * exists to remove.
 *
 * Production census (office_dallas, 2026-07-27) finds ZERO phase-valued subcategories today — only
 * 'CompanyCam' (48,986) and NULL (12,433) — so this changes no current row. The WRITE PATH is live
 * though, so the first user to pick a phase on the capture page would have hit it.
 *
 * 'CompanyCam' is excluded because on that row it is a SOURCE flag, not a phase (see PHOTO_FEED_SOURCES).
 * That is a deliberate divergence from the deal timeline, whose Uncategorized arm requires
 * `subcategory IS NULL` and therefore excludes every CompanyCam photo. On this surface CompanyCam is
 * ~80% of the library, so importing that rule would make "Uncategorized" almost empty and wrong.
 */
const photoPhaseSql = sql`COALESCE(
  ${files.photoCategory}::text,
  CASE WHEN LOWER(${files.subcategory}) = 'companycam' THEN NULL ELSE LOWER(${files.subcategory}) END
)`;
export type PhotoFeedSource = (typeof PHOTO_FEED_SOURCES)[number];

export interface PhotoFeedFilters {
  dealId?: string;
  uploadedBy?: string;
  subcategory?: string;
  /** Phase filter over `files.photo_category`. The literal string "uncategorized" selects NULLs. */
  photoCategory?: string;
  source?: PhotoFeedSource;
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  limit?: number;
}

/**
 * The photo-scope predicate shared by BOTH feed tabs — the Photos tab (`getPhotoFeed`) and the
 * Projects tab (`getProjectPhotoStats`).
 *
 * Extracted deliberately rather than duplicated: when a filter reached one tab and not the other, a
 * Projects row kept reporting the deal's UNFILTERED total ("900 photos") while the filtered Photos tab
 * listed 12 of them. One builder makes that divergence structurally impossible — a new filter cannot be
 * added to one surface and forgotten on the other.
 */
/**
 * Superseded-version exclusion, shared by the row predicate AND the facet scope.
 *
 * DELIBERATELY the cheap child-check, NOT the canonical latestActiveVersionCondition() the deal timeline
 * uses — a measured trade, not an oversight. The canonical form COALESCEs `parent_file_id` on BOTH
 * sides, so neither side is a plain column and `files_version_chain_idx` cannot serve it; it degrades to
 * a hash anti-join over the whole photo table. Measured on production (EXPLAIN ANALYZE, 31,621
 * deal-linked photos, 2026-07-27):
 *     canonical form ......... 125 ms   (Hash Anti Join, 61k-row hash build)
 *     this form ...............  65 ms   (Index Scan on files_version_chain_idx, 0 rows)
 *     the code this replaced ..  69 ms
 * The feed is a cross-deal aggregate over every photo in the tenant, so it pays that on every sort and
 * filter change; the deal timeline pays it over one deal and is right to prefer exactness. It also buys
 * nothing today: production holds ZERO versioned photos.
 *
 * Named and shared so the FACET scope cannot drift from the row scope. When it did, a superseded row
 * could contribute an uploader or phase to a dropdown that no visible feed row matches — selecting it
 * would return an unexplained empty result.
 *
 * Known limitation, inherited unchanged: in a 3+ version family this excludes only the ROOT, so an
 * intermediate v2 still reads as latest. If versioning becomes common, add an index on
 * ((COALESCE(parent_file_id, id)), version) WHERE is_active and switch to the canonical helper.
 */
const notSupersededSql = sql`NOT EXISTS (SELECT 1 FROM files f2 WHERE f2.parent_file_id = files.id AND f2.is_active = true)`;

/**
 * `requireDeal` is the ONLY sanctioned difference between the feed's row scope and any other scope
 * derived from it — expressed as a parameter on the shared builder rather than as a second hand-written
 * condition, because hand-maintaining two predicates that must agree has now failed twice in this file:
 * once when the facet scope omitted the superseded-version exclusion, and again when the fix for that
 * added `deal_id IS NOT NULL` to the facets while `getPhotoFeed` has no deal requirement at all — so an
 * uploader or phase belonging only to an unassigned or lead-linked photo appeared in the GRID but not in
 * its own dropdown. Production holds 29,564 such photos across 4 uploaders, so that is not a corner case.
 *
 * Anything that needs to differ goes here as a named option. Nothing gets a second copy of the base rule.
 */
interface FeedScopeOptions {
  /** Restrict to deal-linked photos. Only the PROJECT-shaped readers want this. */
  requireDeal?: boolean;
}

function buildFeedPhotoConditions(filters: PhotoFeedFilters, options: FeedScopeOptions = {}): SQL[] {
  const conditions: SQL[] = [
    eq(files.category, "photo"),
    eq(files.isActive, true),
    // Superseded-version exclusion — see notSupersededSql above for why it is the cheap child-check.
    notSupersededSql,
  ];

  if (options.requireDeal) conditions.push(sql`${files.dealId} IS NOT NULL`);

  if (filters.dealId) conditions.push(eq(files.dealId, filters.dealId));
  if (filters.uploadedBy) conditions.push(eq(files.uploadedBy, filters.uploadedBy));
  if (filters.subcategory) conditions.push(eq(files.subcategory, filters.subcategory));

  if (filters.photoCategory) {
    // "uncategorized" is a first-class option, not a missing value: ~90% of production photos carry no
    // phase at all, so without it the dropdown could only ever reach 10% of the library.
    // Compares the normalized COLUMN expression cast to text (not the value cast to the enum), so an
    // unknown/stale value from a bookmarked URL filters to nothing instead of aborting the query with a
    // 22P02 enum error -> 500.
    conditions.push(
      filters.photoCategory === "uncategorized"
        ? sql`${photoPhaseSql} IS NULL`
        : sql`${photoPhaseSql} = ${filters.photoCategory.toLowerCase()}`,
    );
  }

  if (filters.source === "companycam") {
    conditions.push(eq(files.subcategory, "CompanyCam"));
  } else if (filters.source === "trock") {
    // IS DISTINCT FROM, not <>: subcategory is NULL on every field/CRM-captured photo, and `NULL <>
    // 'CompanyCam'` is NULL (row dropped), which would make this filter return zero rows.
    conditions.push(sql`${files.subcategory} IS DISTINCT FROM 'CompanyCam'`);
  }

  if (filters.dateFrom) {
    conditions.push(
      sql`COALESCE(${files.takenAt}, ${files.createdAt}) >= ${filters.dateFrom}::timestamptz`
    );
  }
  if (filters.dateTo) {
    conditions.push(
      sql`COALESCE(${files.takenAt}, ${files.createdAt}) <= ${filters.dateTo}::timestamptz`
    );
  }

  return conditions;
}

/**
 * Paginated photo listing across all deals the user can access.
 * RBAC: reps are restricted to deals where they are the assigned rep.
 */
export async function getPhotoFeed(
  tenantDb: TenantDb,
  userRole: string,
  userId: string,
  filters: PhotoFeedFilters
): Promise<{
  photos: Array<{
    id: string;
    displayName: string;
    mimeType: string;
    subcategory: string | null;
    dealId: string | null;
    externalUrl: string | null;
    externalThumbnailUrl: string | null;
    r2Key: string;
    takenAt: Date | null;
    createdAt: Date;
    geoLat: string | null;
    geoLng: string | null;
    uploadedBy: string;
    dealNumber: string | null;
    dealName: string | null;
    uploaderName: string;
  }>;
  pagination: { page: number; limit: number; total: number; totalPages: number };
}> {
  // Clamp rather than trust: `?page=abc` parses to NaN, and `Math.min(NaN, 200)` is NaN, which reaches
  // SQL as `LIMIT NaN` and 500s the feed. Same guard the other paged readers in this file apply.
  const page = Number.isFinite(filters.page) && (filters.page as number) >= 1 ? Math.floor(filters.page as number) : 1;
  const limit = Number.isFinite(filters.limit) && (filters.limit as number) >= 1
    ? Math.min(Math.floor(filters.limit as number), 200)
    : 40;
  const offset = (page - 1) * limit;

  // All users can see all deal photos — no rep filtering
  const where = and(...buildFeedPhotoConditions(filters));

  const countResult = await tenantDb.select({ count: sql<number>`count(*)` }).from(files).where(where);
  const photoRows = await tenantDb
    .select({
      id: files.id,
      displayName: files.displayName,
      mimeType: files.mimeType,
      subcategory: files.subcategory,
      dealId: files.dealId,
      externalUrl: files.externalUrl,
      externalThumbnailUrl: files.externalThumbnailUrl,
      r2Key: files.r2Key,
      takenAt: files.takenAt,
      createdAt: files.createdAt,
      geoLat: files.geoLat,
      geoLng: files.geoLng,
      uploadedBy: files.uploadedBy,
      dealNumber: deals.dealNumber,
      dealName: deals.name,
      uploaderName: sql<string>`COALESCE(${users.displayName}, 'Unknown')`.as("uploader_name"),
    })
    .from(files)
    .leftJoin(deals, eq(deals.id, files.dealId))
    .leftJoin(users, eq(users.id, files.uploadedBy))
    .where(where)
    // `files.id` tiebreaker: bulk imports (a CompanyCam sync, one day's field upload) land with
    // IDENTICAL timestamps, and OFFSET paging over a non-deterministic order lets Postgres arrange tied
    // rows differently per page — the same photo shows on two pages while another never appears. Same
    // fix, same reason, as getDealPhotoTimeline.
    .orderBy(desc(sql`COALESCE(${files.takenAt}, ${files.createdAt})`), desc(files.id))
    .limit(limit)
    .offset(offset);

  const total = Number(countResult[0]?.count ?? 0);

  return {
    photos: photoRows,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

/**
 * Sort keys the Projects tab offers. Whitelisted (never interpolated from the query string) — the sort
 * expression lands in an ORDER BY, so an open-ended value would be an injection point.
 */
export const PROJECT_PHOTO_SORTS = ["recent", "most_photos", "least_photos"] as const;
export type ProjectPhotoSort = (typeof PROJECT_PHOTO_SORTS)[number];

/**
 * KEYSET (cursor) paging for the Projects tab, replacing OFFSET.
 *
 * OFFSET is only correct over a set that does not move. This aggregate moves constantly: every photo
 * upload changes a project's `count(*)` and its `max(taken_at)`, which are the exact values the list is
 * ordered by. A project that gains photos between two requests jumps ahead of the cursor, so page 2
 * re-delivers a project page 1 already showed and the project that was pushed past the boundary is never
 * delivered at all. No amount of client-side de-duplication fixes that, because the client cannot tell
 * "this page repeated rows because the window drifted" from "this page repeated rows because the list
 * ended" — that information does not exist on the client. Guarding it there produced, in sequence, a
 * never-retry bug, an infinite-retry bug, and a silent-truncation bug.
 *
 * A cursor carries the position IN THE ORDERING rather than a row count, so a reorder cannot skip a row:
 * the next page is defined as "everything ordered after this exact (sortValue, dealId)", which stays
 * meaningful however the set changes. `dealId` is the tiebreak that makes the key unique — without it,
 * the dozens of projects sharing a photo count would have no stable boundary.
 *
 * A project can still be RE-DELIVERED if its own sort value changes enough to move it back across the
 * cursor (a project that loses photos under `most_photos`). That is a duplicate, not a gap: the client
 * de-dupes on `dealId` for its React keys anyway, and no project is ever silently dropped.
 */
export interface ProjectPhotoCursor {
  /** The ordering value of the last row delivered — a timestamp or a photo count, as text. */
  sortValue: string;
  dealId: string;
}

/** Opaque to the client: it is a position, not a page number, and must not be arithmetic'd on. */
export function encodeProjectCursor(cursor: ProjectPhotoCursor): string {
  return Buffer.from(`${cursor.sortValue}\u0000${cursor.dealId}`, "utf8").toString("base64url");
}

/**
 * Whether `value` is a Postgres timestamptz literal that Postgres will actually accept.
 *
 * `Date.parse` is not sufficient: it NORMALIZES out-of-range calendar dates (`2026-02-30` becomes
 * March 2) and reports success, while Postgres rejects the original string outright. Anything the
 * regex or the round-trip refuses is treated as a malformed cursor and the list restarts.
 */
function isPostgresTimestampText(value: string): boolean {
  // Every field is RANGE-BOUNDED in the pattern itself. An unbounded `\d{2}` for the hour would accept
  // "99:00:00", which looks well-formed, passes a calendar-only check, and is then rejected by Postgres
  // at the ::timestamptz cast — a 500 from the one function whose contract is "restart the list".
  const match =
    /^(\d{4})-(\d{2})-(\d{2})[ T]([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(\.\d{1,6})?([+-](?:0\d|1[0-5])(?::?[0-5]\d)?|Z)?$/.exec(
      value,
    );
  if (!match) return false;
  const [, year, month, day] = match;
  // Postgres uses the proleptic Gregorian calendar, which has NO year zero (1 BC is followed by 1 AD),
  // so it rejects all 366 dates in `0000` at the ::timestamptz cast. JavaScript's Date DOES have a year
  // 0, accepts it, and round-trips it faithfully — so the calendar check below passes it straight
  // through. The last way a hand-edited cursor could reach Postgres as a bad cast and 500 the one
  // endpoint whose documented contract is "restart the list".
  //
  // Bounded exhaustively against a real ::timestamptz cast rather than reasoned about, so this is known
  // to close the whole class rather than one symptom:
  //   - all 10,000 x 100 x 100 y-m-d combinations the regex can express: the validator accepts
  //     3,652,425 of them, Postgres rejects exactly 366 — every one in year 0000, none in any other year;
  //   - all 86,400 times of day x every timezone form the regex allows, applied to BOTH range boundaries
  //     (0001-01-01 00:00:00 and 9999-12-31 23:59:59) with 1-6 fractional digits: 101,943 accepted,
  //     0 rejected — so no timezone shift pushes a boundary value outside what Postgres can represent.
  //
  // The sweep also found the reverse: Postgres ACCEPTS `24:00:00` and `23:59:60`, which this regex
  // refuses. Left deliberately over-strict — it errs toward restarting the list (harmless) rather than
  // 500ing, and Postgres never EMITS either form, so a legitimately issued cursor cannot contain one.
  if (year === "0000") return false;
  // Calendar overflow too (2026-02-30), which no regex can express — rejected the way Postgres does
  // rather than the way Date.parse does (it silently rolls over and reports success).
  const probe = new Date(`${year}-${month}-${day}T00:00:00Z`);
  return !Number.isNaN(probe.getTime()) && probe.toISOString().slice(0, 10) === `${year}-${month}-${day}`;
}

export function decodeProjectCursor(raw: unknown, sort: ProjectPhotoSort): ProjectPhotoCursor | undefined {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 512) return undefined;
  let decoded: string;
  try {
    decoded = Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    return undefined;
  }
  const separator = decoded.indexOf("\u0000");
  if (separator <= 0) return undefined;
  const sortValue = decoded.slice(0, separator);
  const dealId = decoded.slice(separator + 1);
  // The dealId half lands in a uuid comparison, so a malformed cursor must be DROPPED here rather than
  // reaching Postgres as a bad cast (22P02 -> 500). A stale or hand-edited cursor restarts the list,
  // which is the harmless outcome.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(dealId)) return undefined;
  if (sortValue.length === 0 || sortValue.length > 64) return undefined;
  // The sortValue half is cast too — to bigint for the count sorts, timestamptz for recency — so it needs
  // the SAME treatment as the uuid half. Validating only the uuid left `base64url("abc\0<valid-uuid>")`
  // reaching Postgres as a bad cast: a 500 where the documented behaviour is "restart the list".
  const sortValueValid = sort === "recent"
    ? isPostgresTimestampText(sortValue)
    // bigint, and bounded so a 40-digit count cannot overflow the cast either.
    : /^\d{1,18}$/.test(sortValue);
  if (!sortValueValid) return undefined;
  return { sortValue, dealId };
}

const PROJECT_STATS_DEFAULT_LIMIT = 50;
const PROJECT_STATS_MAX_LIMIT = 100;
const PROJECT_RECENT_PHOTO_COUNT = 5;
const PROJECT_RECENT_UPLOADER_COUNT = 10;

export interface ProjectPhotoStatsOptions extends PhotoFeedFilters {
  sort?: ProjectPhotoSort;
  /** Keyset position from the previous page's `nextCursor`. Absent = first page. */
  cursor?: string;
  /** Restrict to deals owned by this rep — the "My Projects" pill. */
  assignedRepId?: string;
  /** Free-text match over deal name / number / property city — the search box. */
  search?: string;
}

export interface ProjectPhotoStat {
  dealId: string;
  dealName: string;
  dealNumber: string;
  /** Owner of the deal. Powers the "My Projects" pill, which had nothing to filter on before. */
  assignedRepId: string | null;
  propertyCity: string | null;
  propertyState: string | null;
  photoCount: number;
  lastPhotoAt: string | null;
  recentUploaders: string[];
  recentPhotoIds: string[];
  recentPhotos: Array<{
    id: string;
    displayName: string | null;
    mimeType: string | null;
    r2Key: string | null;
    externalUrl: string | null;
    externalThumbnailUrl: string | null;
  }>;
}

/** JSON columns arrive parsed under node-postgres but as text under some drivers — accept both. */
function parseJsonColumn<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

/**
 * Aggregate photo stats grouped by project (deal) — the Projects tab of the photo feed.
 *
 * SORTING IS SERVER-SIDE BY CONSTRUCTION. The rows are ordered and then paged in SQL, so "most photos"
 * means the most-photographed projects in the tenant. Sorting the response array in the browser would
 * instead rank whatever the server happened to return — i.e. "the most-photographed of the N most
 * RECENT projects" — which looks plausible and is wrong. `project-stats-sort.runtime.test.ts` seeds
 * more projects than one page holds specifically to fail if that ever regresses.
 *
 * COST. Two statements, both bounded:
 *   1. the grouped aggregate (unavoidable — you cannot order by a count without computing it), which
 *      the existing partial index `files_photo_timeline_idx (deal_id, category, COALESCE(taken_at,
 *      created_at) DESC) WHERE category='photo' AND is_active=TRUE` already serves as a pre-sorted
 *      GroupAggregate: 11ms for 31,621 photos across 166 projects on production (EXPLAIN ANALYZE,
 *      2026-07-27). No denormalized counter column is warranted for that, and one would add write-path
 *      drift for no measurable read gain.
 *   2. the recent-photo strip for ONLY the projects on the returned page.
 * This replaces three CORRELATED SUBQUERIES that each re-scanned a deal's photos per group (3xN lateral
 * scans per request, N = up to 100 groups) — the previous shape got strictly worse under a sort that
 * can surface the largest galleries first. The single-pass row_number() window mirrors
 * getUnassignedCompanyCamProjects below.
 *
 * `tenantDb` is one transaction-bound pg client, so the two statements MUST run sequentially —
 * Promise.all would trip "client already executing" and 500 the page.
 */
export async function getProjectPhotoStats(
  tenantDb: TenantDb,
  options: ProjectPhotoStatsOptions = {},
): Promise<{
  projects: ProjectPhotoStat[];
  pagination: {
    limit: number;
    /**
     * Total matching projects. Computed ONLY on the first page: the keyset predicate lives in HAVING, so
     * the `count(*) OVER ()` window would otherwise count what REMAINS after the cursor and the header
     * would count down as the user paged. `null` on cursor pages means "unchanged" — the client keeps
     * the figure it already has.
     */
    total: number | null;
    /** Position to resume from, or `null` when the server has nothing further. The ONLY end signal. */
    nextCursor: string | null;
  };
}> {
  const sort: ProjectPhotoSort = PROJECT_PHOTO_SORTS.includes(options.sort as ProjectPhotoSort)
    ? (options.sort as ProjectPhotoSort)
    : "recent";
  const limit = Number.isFinite(options.limit) && (options.limit as number) >= 1
    ? Math.min(Math.floor(options.limit as number), PROJECT_STATS_MAX_LIMIT)
    : PROJECT_STATS_DEFAULT_LIMIT;
  // A malformed/stale cursor decodes to undefined and simply restarts the list — never a 400, never a
  // bad uuid cast reaching Postgres.
  const cursor = decodeProjectCursor(options.cursor, sort);

  // Ownership and search narrow the SAME query the sort and paging run on. Filtering them in the
  // browser instead would repeat the sort-after-truncation mistake in a second place: under
  // `most_photos`, "My Projects" would quietly mean "the rep's projects among the 100
  // most-photographed", and the header's project count would describe a different set than the rows
  // beneath it.
  // TWO predicates, on purpose. `photoWhere` touches only `files` columns, so it can be reused verbatim
  // inside the strip CTE (which selects `FROM files` and never joins `deals`); the deal-level narrowing
  // below would not resolve there. The strip is already confined to the page's deal ids, so it does not
  // need them.
  const photoWhere = and(...buildFeedPhotoConditions(options, { requireDeal: true }))!;
  const projectConditions: SQL[] = [photoWhere];
  if (options.assignedRepId) projectConditions.push(eq(deals.assignedRepId, options.assignedRepId));
  if (options.search) {
    // Escape LIKE wildcards so a literal % or _ typed into the search box matches itself rather than
    // silently widening the search to everything.
    const term = `%${options.search.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
    projectConditions.push(
      sql`(${deals.name} ILIKE ${term} OR ${deals.dealNumber} ILIKE ${term} OR ${deals.propertyCity} ILIKE ${term})`,
    );
  }
  const where = and(...projectConditions)!;

  const lastPhotoAtSql = sql`max(COALESCE(${files.takenAt}, ${files.createdAt}))`;
  const orderBy: SQL = sort === "most_photos"
    ? sql`count(*) DESC`
    : sort === "least_photos"
      ? sql`count(*) ASC`
      : sql`${lastPhotoAtSql} DESC NULLS LAST`;

  // The keyset predicate: "strictly after this position in THIS ordering". Written per sort because the
  // comparison direction has to match the ORDER BY — a `<` where the ordering ascends silently returns
  // the rows already delivered. `deal_id` breaks the tie, and its `>` is the same in all three because
  // the tiebreak is always ascending.
  //
  // ACCEPTED LIMITATION — the cursor is stable, the ORDERING KEY is not. `count(*)` and `max(taken_at)`
  // both move when photos are uploaded, so a project that gains photos mid-scroll can jump AHEAD of an
  // already-issued cursor and then fail this predicate for the rest of the walk: the user reaches the end
  // without seeing it. No cursor scheme fixes this; it needs an ordering SNAPSHOT or a client-side
  // refresh-and-merge of earlier pages.
  //
  // Deliberately not built, on severity. This is an INTERNAL list and the worst case is that someone
  // scrolling misses a project that changed while they scrolled — a refresh shows it. The same class on
  // the public share viewer was worth chasing because there it meant a CLIENT silently received fewer
  // photos than were sent; that is a different order of consequence, and that surface is out of scope
  // for this PR anyway. What keyset DOES remove here is the shifting-window class, where an unrelated
  // write drops a row the user was entitled to see — see the runtime test that pins it.
  //
  // `files.created_at` is NOT NULL, so `max(COALESCE(taken_at, created_at))` is never NULL for a group
  // that exists — the NULLS LAST above is defensive, and the cursor never has to encode a null.
  const havingCursor: SQL | undefined = cursor
    ? sort === "most_photos"
      ? sql`(count(*) < ${cursor.sortValue}::bigint OR (count(*) = ${cursor.sortValue}::bigint AND ${files.dealId} > ${cursor.dealId}::uuid))`
      : sort === "least_photos"
        ? sql`(count(*) > ${cursor.sortValue}::bigint OR (count(*) = ${cursor.sortValue}::bigint AND ${files.dealId} > ${cursor.dealId}::uuid))`
        : sql`(${lastPhotoAtSql} < ${cursor.sortValue}::timestamptz OR (${lastPhotoAtSql} = ${cursor.sortValue}::timestamptz AND ${files.dealId} > ${cursor.dealId}::uuid))`
    : undefined;

  const rows = await tenantDb
    .select({
      dealId: files.dealId,
      dealName: deals.name,
      dealNumber: deals.dealNumber,
      assignedRepId: deals.assignedRepId,
      propertyCity: deals.propertyCity,
      propertyState: deals.propertyState,
      photoCount: sql<number>`count(*)::int`,
      lastPhotoAt: sql<string>`${lastPhotoAtSql}::text`,
      // Window over the GROUPED result (window functions run after GROUP BY, before LIMIT), so this is
      // the number of matching projects — no second COUNT(DISTINCT deal_id) round-trip. Only meaningful
      // on the first page; past a cursor it counts what REMAINS (the keyset predicate is in HAVING).
      totalProjects: sql<number>`(count(*) OVER ())::int`,
    })
    .from(files)
    .innerJoin(deals, eq(deals.id, files.dealId))
    .where(where)
    .groupBy(files.dealId, deals.name, deals.dealNumber, deals.assignedRepId, deals.propertyCity, deals.propertyState)
    .having(havingCursor)
    // Tiebreaker is load-bearing, not cosmetic: on `most_photos` dozens of projects share a count, and
    // without a deterministic second key the cursor has no unique boundary to resume from.
    .orderBy(orderBy, files.dealId)
    .limit(limit);

  const total = cursor ? null : Number(rows[0]?.totalProjects ?? 0);
  // A full page MAY have more after it; a short page cannot. At worst this costs one extra request at an
  // exact multiple of the page size, which then returns nothing and ends the walk — bounded, and never
  // the reverse error of stopping while rows remain.
  const lastRow = rows.length === limit ? rows[rows.length - 1] : undefined;
  const nextCursor = lastRow?.dealId
    ? encodeProjectCursor({
        sortValue: sort === "recent" ? String(lastRow.lastPhotoAt) : String(lastRow.photoCount),
        dealId: lastRow.dealId,
      })
    : null;
  const dealIds = rows.map((row) => row.dealId).filter((id): id is string => Boolean(id));

  // Recent-photo strip + uploader avatars, for the RETURNED PAGE ONLY. Same `where` as the aggregate, so
  // a filtered Projects row's thumbnails are drawn from the same photos its count was computed over.
  const stripByDeal = new Map<string, { recentPhotos: ProjectPhotoStat["recentPhotos"]; recentUploaders: string[] }>();
  if (dealIds.length > 0) {
    const stripResult = await tenantDb.execute(sql`
      WITH ranked AS (
        SELECT
          ${files.dealId} AS deal_id,
          ${files.id} AS id,
          ${files.displayName} AS display_name,
          ${files.mimeType} AS mime_type,
          ${files.r2Key} AS r2_key,
          ${files.externalUrl} AS external_url,
          ${files.externalThumbnailUrl} AS external_thumbnail_url,
          COALESCE(uploader.display_name, 'Unknown') AS uploader_name,
          row_number() OVER (
            PARTITION BY ${files.dealId}
            ORDER BY COALESCE(${files.takenAt}, ${files.createdAt}) DESC NULLS LAST, ${files.id} DESC
          ) AS rn
        FROM ${files}
        LEFT JOIN ${users} uploader ON uploader.id = ${files.uploadedBy}
        WHERE ${photoWhere} AND ${inArray(files.dealId, dealIds)}
      )
      SELECT
        deal_id AS "dealId",
        COALESCE(json_agg(json_build_object(
          'id', id,
          'displayName', display_name,
          'mimeType', mime_type,
          'r2Key', r2_key,
          'externalUrl', external_url,
          'externalThumbnailUrl', external_thumbnail_url
        ) ORDER BY rn) FILTER (WHERE rn <= ${PROJECT_RECENT_PHOTO_COUNT}), '[]'::json) AS "recentPhotos",
        COALESCE(json_agg(DISTINCT uploader_name) FILTER (WHERE rn <= ${PROJECT_RECENT_UPLOADER_COUNT}), '[]'::json) AS "recentUploaders"
      FROM ranked
      GROUP BY deal_id
    `);

    const stripRows = ((stripResult as unknown as { rows?: unknown[] }).rows ?? stripResult) as Array<{
      dealId: string;
      recentPhotos: unknown;
      recentUploaders: unknown;
    }>;
    for (const row of stripRows) {
      stripByDeal.set(row.dealId, {
        recentPhotos: parseJsonColumn(row.recentPhotos, [] as ProjectPhotoStat["recentPhotos"]),
        recentUploaders: parseJsonColumn(row.recentUploaders, [] as string[]),
      });
    }
  }

  return {
    projects: rows.map((row) => {
      const strip = stripByDeal.get(row.dealId!) ?? { recentPhotos: [], recentUploaders: [] };
      return {
        dealId: row.dealId!,
        dealName: row.dealName,
        dealNumber: row.dealNumber,
        assignedRepId: row.assignedRepId ?? null,
        propertyCity: row.propertyCity,
        propertyState: row.propertyState,
        photoCount: row.photoCount,
        lastPhotoAt: row.lastPhotoAt,
        recentUploaders: strip.recentUploaders,
        // Kept for the client's degraded-payload fallback path (it renders ids when recentPhotos is
        // empty). Derived from the same strip instead of a third correlated subquery.
        recentPhotoIds: strip.recentPhotos.map((photo) => photo.id),
        recentPhotos: strip.recentPhotos,
      };
    }),
    pagination: { limit, total, nextCursor },
  };
}

/**
 * Options for the feed's filter dropdowns.
 *
 * Derived from the WHOLE photo library and deliberately ignoring the currently-applied filters — the
 * same rule getDealPhotoUploaders applies to the deal-level timeline. If the options were narrowed to
 * the current result set, the option the user just selected could vanish from its own dropdown the
 * instant it took effect, leaving no way to undo it.
 *
 * Only dimensions the data actually carries are offered. Verified against production 2026-07-27:
 * 25 distinct uploaders / 0 null; photo_category present on 3,280 of 31,621 deal-linked photos
 * (construction 1,701, estimating 994, preconstruction 552, site_visit 33) with the rest NULL — hence
 * the "uncategorized" option. Source is a fixed two-value list, not a facet (see PHOTO_FEED_SOURCES).
 */
export async function getPhotoFeedFacets(tenantDb: TenantDb): Promise<{
  uploaders: Array<{ id: string; name: string }>;
  photoCategories: string[];
  projects: Array<{ id: string; name: string }>;
}> {
  // Literally the feed's own row predicate, with no filters applied — not a re-statement of it. An
  // option that cannot match a feed row (or a feed row whose uploader has no option) is exactly what
  // hand-maintaining a second copy produced, twice.
  const scope = and(...buildFeedPhotoConditions({}))!;
  // The PROJECT picker is the one facet that legitimately needs a deal, because it lists deals. Same
  // builder, one named option — so it cannot drift from the rest either.
  const projectScope = and(...buildFeedPhotoConditions({}, { requireDeal: true }))!;

  // Sequential, not Promise.all — tenantDb is a single transaction-bound pg client.
  const uploaderRows = await tenantDb
    .selectDistinct({
      id: files.uploadedBy,
      name: sql<string>`COALESCE(${users.displayName}, 'Unknown')`.as("uploader_name"),
    })
    .from(files)
    .leftJoin(users, eq(users.id, files.uploadedBy))
    .where(scope);

  // Same normalized expression as the predicate, so an option can never appear in the dropdown that the
  // filter then cannot match (or vice versa).
  const categoryRows = await tenantDb
    .selectDistinct({ value: sql<string | null>`${photoPhaseSql}` })
    .from(files)
    .where(scope);

  // The Photos tab's project picker. It has to come from the FULL project list, not from the currently
  // filtered project rows: those are narrowed and paged, so the project a user had already selected
  // could drop out of its own dropdown the moment they applied a date range — the select would render
  // blank while still sending its dealId to the feed, leaving no way to undo the selection.
  const projectRows = await tenantDb
    .selectDistinct({ id: files.dealId, name: deals.name })
    .from(files)
    .innerJoin(deals, eq(deals.id, files.dealId))
    .where(projectScope);

  return {
    uploaders: uploaderRows
      .filter((row): row is { id: string; name: string } => Boolean(row.id))
      .sort((left, right) => left.name.localeCompare(right.name)),
    photoCategories: categoryRows
      .map((row) => row.value)
      .filter((value): value is string => Boolean(value))
      .sort(),
    projects: projectRows
      .filter((row): row is { id: string; name: string } => Boolean(row.id))
      .sort((left, right) => (left.name ?? "").localeCompare(right.name ?? "")),
  };
}

// CompanyCam rescue photos that aren't linked to a deal (deal_id IS NULL) carry their source project
// id/name in the `notes` JSON. Guard the ::jsonb cast with pg_input_is_valid so it NEVER runs on a
// non-JSON notes value — a first-char `{` check is not enough (e.g. a hand-typed `{needs review`
// would still abort the whole query). CASE only evaluates THEN when the validity check passes.
const ccProjectIdExpr = sql<string | null>`CASE WHEN pg_input_is_valid(btrim(${files.notes}), 'jsonb') THEN (btrim(${files.notes})::jsonb ->> 'companycamProjectId') END`;
const ccProjectNameExpr = sql<string | null>`CASE WHEN pg_input_is_valid(btrim(${files.notes}), 'jsonb') THEN (btrim(${files.notes})::jsonb ->> 'companycamProjectName') END`;

/**
 * Unassigned CompanyCam photos grouped by their source CompanyCam project (mirrors CompanyCam's own
 * project-folder structure). Powers the "Unassigned" tab on the photo feed. One row per CompanyCam
 * project that has at least one unlinked rescued photo.
 */
export async function getUnassignedCompanyCamProjects(tenantDb: TenantDb): Promise<{
  projects: Array<{
    companycamProjectId: string;
    companycamProjectName: string | null;
    photoCount: number;
    lastPhotoAt: string | null;
    recentPhotos: Array<{
      id: string;
      displayName: string | null;
      mimeType: string | null;
      r2Key: string | null;
      externalUrl: string | null;
      externalThumbnailUrl: string | null;
    }>;
  }>;
}> {
  // CTE makes the CASE-guarded project id a real column so we can GROUP BY it and rank within each
  // project (a correlated subquery over the ungrouped `notes` is illegal post-GROUP BY). row_number()
  // + json_agg FILTER picks the 5 most-recent photos per project in one pass.
  const result = await tenantDb.execute(sql`
    WITH cc AS (
      SELECT ${files.id} AS id, ${files.displayName} AS display_name, ${files.mimeType} AS mime_type,
             ${files.r2Key} AS r2_key, ${files.externalUrl} AS external_url,
             ${files.externalThumbnailUrl} AS external_thumbnail_url,
             COALESCE(${files.takenAt}, ${files.createdAt}) AS sort_at,
             ${ccProjectIdExpr} AS pid, ${ccProjectNameExpr} AS pname
      FROM ${files}
      WHERE ${files.category} = 'photo' AND ${files.isActive} = true
        AND ${files.subcategory} = 'CompanyCam' AND ${files.dealId} IS NULL
    ),
    ranked AS (
      SELECT *, row_number() OVER (PARTITION BY pid ORDER BY sort_at DESC NULLS LAST) AS rn
      FROM cc WHERE pid IS NOT NULL
    )
    SELECT
      pid AS "companycamProjectId",
      max(pname) AS "companycamProjectName",
      count(*)::int AS "photoCount",
      max(sort_at)::text AS "lastPhotoAt",
      COALESCE(json_agg(json_build_object(
        'id', id, 'displayName', display_name, 'mimeType', mime_type,
        'r2Key', r2_key, 'externalUrl', external_url, 'externalThumbnailUrl', external_thumbnail_url
      ) ORDER BY sort_at DESC NULLS LAST) FILTER (WHERE rn <= 5), '[]'::json) AS "recentPhotos"
    FROM ranked
    GROUP BY pid
    ORDER BY max(sort_at) DESC NULLS LAST
  `);
  // No LIMIT: the result is one row per distinct unassigned CompanyCam project (naturally bounded by
  // the account's project count), so the tab never silently hides projects.

  const rows = (result as unknown as {
    rows: Array<{
      companycamProjectId: string;
      companycamProjectName: string | null;
      photoCount: number;
      lastPhotoAt: string | null;
      recentPhotos: unknown;
    }>;
  }).rows;

  return {
    projects: rows.map((r) => ({
      companycamProjectId: r.companycamProjectId,
      companycamProjectName: r.companycamProjectName,
      photoCount: Number(r.photoCount),
      lastPhotoAt: r.lastPhotoAt,
      recentPhotos: Array.isArray(r.recentPhotos)
        ? (r.recentPhotos as never[])
        : typeof r.recentPhotos === "string"
          ? JSON.parse(r.recentPhotos)
          : [],
    })),
  };
}

/**
 * Paginated unassigned CompanyCam photos for a single source project (the drill-in from the
 * "Unassigned" tab). Same item shape as getPhotoFeed so the client grid can be reused.
 */
export async function getUnassignedCompanyCamPhotos(
  tenantDb: TenantDb,
  companycamProjectId: string,
  page = 1,
  limit = 40,
): Promise<{
  photos: Array<{
    id: string;
    displayName: string;
    mimeType: string;
    subcategory: string | null;
    dealId: string | null;
    externalUrl: string | null;
    externalThumbnailUrl: string | null;
    r2Key: string;
    takenAt: Date | null;
    createdAt: Date;
    geoLat: string | null;
    geoLng: string | null;
    uploadedBy: string;
    dealNumber: string | null;
    dealName: string | null;
    uploaderName: string;
  }>;
  pagination: { page: number; limit: number; total: number; totalPages: number };
}> {
  // Guard against bad query params (NaN/0/negative from `?page=abc`/`?limit=-1`) that would otherwise
  // produce a NaN/negative OFFSET or divide-by-zero totalPages.
  const safePage = Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1;
  const safeLimit = Number.isFinite(limit) && limit >= 1 ? Math.min(Math.floor(limit), 200) : 40;
  const offset = (safePage - 1) * safeLimit;
  const where = and(
    eq(files.category, "photo"),
    eq(files.isActive, true),
    eq(files.subcategory, "CompanyCam"),
    sql`${files.dealId} IS NULL`,
    sql`${ccProjectIdExpr} = ${companycamProjectId}`,
  );

  const countResult = await tenantDb.select({ count: sql<number>`count(*)` }).from(files).where(where);
  const photoRows = await tenantDb
    .select({
      id: files.id,
      displayName: files.displayName,
      mimeType: files.mimeType,
      subcategory: files.subcategory,
      dealId: files.dealId,
      externalUrl: files.externalUrl,
      externalThumbnailUrl: files.externalThumbnailUrl,
      r2Key: files.r2Key,
      takenAt: files.takenAt,
      createdAt: files.createdAt,
      geoLat: files.geoLat,
      geoLng: files.geoLng,
      uploadedBy: files.uploadedBy,
      dealNumber: sql<string | null>`NULL`,
      dealName: ccProjectNameExpr,
      uploaderName: sql<string>`COALESCE(${users.displayName}, 'Unknown')`.as("uploader_name"),
    })
    .from(files)
    .leftJoin(users, eq(users.id, files.uploadedBy))
    .where(where)
    // Deterministic tiebreaker, same rationale as getPhotoFeed — this reader pages too.
    .orderBy(desc(sql`COALESCE(${files.takenAt}, ${files.createdAt})`), desc(files.id))
    .limit(safeLimit)
    .offset(offset);

  const total = Number(countResult[0]?.count ?? 0);
  return { photos: photoRows, pagination: { page: safePage, limit: safeLimit, total, totalPages: Math.ceil(total / safeLimit) } };
}

/**
 * "Assign to deal" action on the Unassigned tab: move EVERY unassigned (deal-less) CompanyCam photo of one
 * source project onto a deal. Sets files.deal_id for exactly the rows getUnassignedCompanyCamPhotos lists for
 * the project (the SAME five-predicate filter), so the project drops out of the Unassigned tab and its photos
 * appear under the deal. Idempotent: it only touches still-unassigned rows, so re-running moves nothing and
 * never re-homes already-assigned photos. The deal must exist and be active in this tenant. Universal — the
 * route imposes no role gate (mirrors the GET endpoints), so any CRM user can consolidate the backlog.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function assignUnassignedCompanyCamProjectToDeal(
  tenantDb: TenantDb,
  companycamProjectId: string,
  dealId: string,
): Promise<{ assignedCount: number; dealId: string; companycamProjectId: string }> {
  const projectId = companycamProjectId?.trim();
  if (!projectId) throw new AppError(400, "companycamProjectId is required");

  // Validate the deal id shape HERE (not just at the route) so a malformed id from any caller fails the
  // 400 contract instead of falling through to Postgres as a generic 500 on the uuid comparison (CodeRabbit).
  const targetDealId = dealId?.trim();
  if (!targetDealId || !UUID_PATTERN.test(targetDealId)) {
    throw new AppError(400, "A valid dealId is required");
  }

  const [deal] = await tenantDb
    .select({ id: deals.id })
    .from(deals)
    // Exclude test-data deals (mirrors excludeTestDataCondition on the normal deals list/search): they are
    // hidden from the picker, so a crafted/stale request must not be able to bury production photos on one.
    .where(and(eq(deals.id, targetDealId), eq(deals.isActive, true), sql`COALESCE(${deals.isTestData}, false) = false`))
    .limit(1);
  if (!deal) throw new AppError(404, "Deal not found");

  // A deal can now own MANY CompanyCam projects (the link lives in deal_companycam_projects, a project
  // stays 1:1 to a deal via the UNIQUE on companycam_project_id). So a 2nd/3rd different project ADDS a
  // link instead of being rejected — there is no "different project" guard anymore.

  // Serialize on BOTH the project AND the target deal (transaction-scoped advisory locks, auto-released at
  // commit). The project lock alone is insufficient: two DIFFERENT projects assigned to the same deal would
  // take different project locks, both move their photos, and a concurrent uniqueness re-check could race.
  // Acquire in sorted key order so two concurrent requests that touch the same {project, deal} pair can't
  // deadlock.
  for (const key of [projectId, targetDealId].sort()) {
    await tenantDb.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`);
  }

  // Don't STEAL the project from a deal it's already linked to. A project is 1:1 with a deal, so if the join
  // table already maps this project to a DIFFERENT deal, refuse rather than split the project across deals
  // (its future syncs would go to the wrong one). Require an explicit relink in that case (Codex).
  const [linkedElsewhere] = await tenantDb
    .select({ dealId: dealCompanycamProjects.dealId })
    .from(dealCompanycamProjects)
    .where(
      and(
        eq(dealCompanycamProjects.companycamProjectId, projectId),
        sql`${dealCompanycamProjects.dealId} <> ${targetDealId}`,
      ),
    )
    .limit(1);
  if (linkedElsewhere) {
    throw new AppError(409, "This CompanyCam project is already linked to another deal");
  }

  // CLAIM THE PHOTOS. The UPDATE takes row locks on the project's unassigned files, so a concurrent request
  // blocks and then matches 0 rows (deal_id is no longer NULL). We only persist the project -> deal link when
  // this request actually moved rows — a stale assignment that claimed 0 files must not stamp the mapping.
  const moved = await tenantDb
    .update(files)
    .set({ dealId: targetDealId })
    .where(
      and(
        eq(files.category, "photo"),
        eq(files.isActive, true),
        eq(files.subcategory, "CompanyCam"),
        sql`${files.dealId} IS NULL`,
        sql`${ccProjectIdExpr} = ${projectId}`,
      ),
    )
    .returning({ id: files.id });

  if (moved.length > 0) {
    // Persist the project -> deal link in the join table so future photos auto-link here
    // (syncAllLinkedProjects syncs every project mapped to an active deal). ON CONFLICT DO NOTHING makes a
    // re-assign of the same project idempotent; the uniqueness check above already guaranteed the project is
    // mapped nowhere else (so the conflict, if any, is this same {deal, project} pair).
    await tenantDb
      .insert(dealCompanycamProjects)
      .values({ dealId: targetDealId, companycamProjectId: projectId })
      .onConflictDoNothing({ target: dealCompanycamProjects.companycamProjectId });

    // Mirror the link onto the legacy scalar deals.companycam_project_id. The scalar is a DENORMALIZED
    // MIRROR kept only so un-migrated legacy readers (companycam-import/inventory) still detect the link for
    // the single-project case; deal_companycam_projects is the source of truth. #830 migrates those readers
    // and drops the column. For a multi-project deal the scalar holds the most-recent link (accepted interim).
    await tenantDb
      .update(deals)
      .set({ companycamProjectId: projectId })
      .where(eq(deals.id, targetDealId));
  }

  return { assignedCount: moved.length, dealId: targetDealId, companycamProjectId: projectId };
}

/**
 * Count photos created on or after `since`.
 * Same RBAC filter as getPhotoFeed — reps only see photos from their assigned deals.
 */
export async function getNewPhotoCount(
  tenantDb: TenantDb,
  userRole: string,
  userId: string,
  since: Date
): Promise<number> {
  const conditions: SQL[] = [
    eq(files.category, "photo"),
    eq(files.isActive, true),
    gte(files.createdAt, since),
  ];

  // All users can see all deal photos — no rep filtering

  const [result] = await tenantDb
    .select({ count: sql<number>`count(*)` })
    .from(files)
    .where(and(...conditions));

  return Number(result?.count ?? 0);
}
