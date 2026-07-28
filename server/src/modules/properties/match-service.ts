import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";

// Matches the alias the sibling service declares — this module only needs `execute`.
type TenantDb = NodePgDatabase<typeof schema>;

/**
 * "Which property am I standing at?" — the guard that decides whether field prospecting FIXES the
 * duplicate-property problem or multiplies it.
 *
 * There are already ~94 duplicate property groups, and the documented fix for explicit property
 * creation was waiting on canonical Mapbox addresses. Field capture is the moment that supplies them:
 * a rep reverse-geocodes where they are, this matches against what already exists, and a new property
 * is created only when nothing does. Get it wrong and every visit to the same building mints another
 * row — the same defect, now at door-knock frequency.
 *
 * TWO SIGNALS, because neither is sufficient alone:
 *
 *   ADDRESS is the strong one. It is the only signal that works against the existing table, where
 *   nothing on the write path has ever populated lat/lng — a property created through the API has null
 *   coordinates, so a distance-only match would silently miss every one of them and create a duplicate
 *   beside it.
 *
 *   DISTANCE is the recovering one. It catches the cases address text cannot: a building the rep knows
 *   as "Palm Villas" and Mapbox calls "1420 Bishop St", a suite number on one side only, a typo.
 *
 * So a row matches on either, and both are reported, so the client can say WHY it is offering a
 * property rather than presenting an unexplained guess.
 */

/** Metres. A commercial parcel, not a neighbourhood — wide enough for GPS drift beside a big building. */
export const PROPERTY_MATCH_RADIUS_METERS = 200;
export const PROPERTY_MATCH_LIMIT = 8;
/**
 * How many rows SQL may hand TypeScript before the real decision is made.
 *
 * Larger than PROPERTY_MATCH_LIMIT on purpose: the SQL predicate is deliberately loose (see below), so
 * this is the ceiling on candidates, not on answers. Small enough that a shared house number on a busy
 * street cannot turn one capture into a table scan's worth of work.
 */
const CANDIDATE_LIMIT = 200;

/** Degrees of latitude per metre. Constant enough for a bounding box; the exact test is haversine. */
const METERS_PER_DEGREE_LAT = 111_320;

export type PropertyMatchReason = "address" | "distance" | "address+distance";

export interface PropertyMatch {
  id: string;
  name: string;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  companyId: string;
  companyName: string | null;
  /** Metres from the query point. Null when the property has no stored coordinates. */
  distanceMeters: number | null;
  reason: PropertyMatchReason;
  /**
   * "exact" same building AND unit, "base" same building with a unit on one side only, null when the
   * row was reached by proximity alone. Surfaced so the capture screen can present a base match as
   * "is this the one?" rather than as a settled answer.
   */
  addressMatch: AddressMatchQuality;
}

/**
 * Common US street-suffix abbreviations, expanded to one canonical form.
 *
 * "1420 Bishop Street" and "1420 Bishop St" are the same building and differ by four characters, which
 * is precisely how the existing duplicates were made. Deliberately SHORT: every entry is a claim that
 * two spellings mean the same thing, and a wrong claim silently merges two real buildings — a worse
 * failure than missing a match, because the rep cannot see it happen.
 */
const STREET_TYPES: Record<string, string> = {
  st: "street", str: "street",
  ave: "avenue", av: "avenue",
  rd: "road",
  blvd: "boulevard", blv: "boulevard",
  dr: "drive",
  ln: "lane",
  ct: "court",
  cir: "circle",
  pl: "place",
  ter: "terrace",
  pkwy: "parkway", pky: "parkway",
  hwy: "highway",
  expy: "expressway",
  sq: "square",
  trl: "trail",
};

/** Directionals read the same wherever they sit — "100 N Main St", "100 Main St N". */
const DIRECTIONALS: Record<string, string> = {
  n: "north", s: "south", e: "east", w: "west",
  ne: "northeast", nw: "northwest", se: "southeast", sw: "southwest",
};

/**
 * Abbreviations that mean something DIFFERENT away from the street-type position.
 *
 * `st` is the whole reason this map exists. As the last token of a street line it is "Street"; anywhere
 * else it is "Saint". Expanding it everywhere turned "1 St Charles Ave" into "1 street charles avenue"
 * and rejected an uncoordinated legacy row spelling the same building "1 Saint Charles Avenue" — a
 * silent false negative, and a duplicate.
 */
const NON_FINAL_ALIASES: Record<string, string> = { st: "saint" };

/**
 * A comparable key for a street address.
 *
 * Lowercased, punctuation stripped, whitespace collapsed, suffixes expanded. Unit/suite markers are
 * NOT removed — "1420 Bishop St Ste 200" and "1420 Bishop St Ste 400" are different tenancies and a rep
 * standing at one should not be shown the other as the same record.
 */
export function normalizeAddressKey(value: string | null | undefined): string {
  if (typeof value !== "string") return "";
  const cleaned = value
    .toLowerCase()
    // FOLD accents rather than deleting the letter. The punctuation strip below turns any character
    // outside [a-z0-9] into a space, so "Cañon" became "ca on" — two tokens that match nothing, least
    // of all a legacy row spelling it "Canon". Decompose, drop the combining marks, keep the letter.
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    // "#200" is a UNIT, and stripping the hash to whitespace destroyed that: "1420 Bishop St #200"
    // became "1420 bishop street 200", which splitUnit cannot recognise — so a legacy row storing the
    // tenancy was rejected against a building-level geocode and a duplicate created. The suite case was
    // handled for the spelled-out markers and missed for the one people actually type.
    .replace(/#\s*/g, " unit ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";

  const tokens = cleaned.split(" ");
  const unitAt = findUnitIndex(tokens);
  const baseEnd = unitAt === -1 ? tokens.length : unitAt;

  /**
   * Where the street TYPE sits — normally the last token of the base, but one further left when a
   * trailing directional follows it ("100 Main St N"). Without that step the "St" in such a line is not
   * in the type position, so it expands to "Saint" and "100 Main St N" stops matching "100 Main Street
   * North".
   */
  let typeIndex = baseEnd - 1;
  // A trailing directional ("100 Main St N") or a ROUTE NUMBER ("100 County Rd 123") sits after the
  // street type, so the type is one further left. Without this "Rd" is not in the type position, stays
  // unexpanded, and "100 County Rd 123" never matches "100 County Road 123".
  if (typeIndex >= 1) {
    const last = tokens[typeIndex]!;
    const prev = tokens[typeIndex - 1]!;
    if ((DIRECTIONALS[last] || /^\d+$/.test(last)) && STREET_TYPES[prev]) typeIndex -= 1;
  }

  /**
   * A lone letter between the house number and the street type IS the street name.
   *
   * "100 E St" is E Street — a real street in more than one US city — not "100 East St". Expanding it
   * merges two distinct addresses, and a false match is the failure this file refuses to trade for a
   * missed one. A directional with a name after it ("100 N Main St") is unambiguous and still expands.
   */
  const nameIsSingleLetter = baseEnd === 3 && tokens[1]!.length === 1;

  return tokens
    .map((token, index) => {
      if (index >= baseEnd) return UNIT_MARKER_CANONICAL[token] ?? token;
      if (index === typeIndex) return STREET_TYPES[token] ?? DIRECTIONALS[token] ?? token;
      if (index === 1 && nameIsSingleLetter) return token;
      return DIRECTIONALS[token] ?? NON_FINAL_ALIASES[token] ?? token;
    })
    .join(" ");
}

/** Unit designators, as they appear at the END of a street line. */
const UNIT_MARKERS = new Set(["ste", "suite", "unit", "apt", "apartment", "rm", "room", "fl", "floor", "bldg", "building"]);

/**
 * Markers that name the SAME kind of slot, folded to one word.
 *
 * "1420 Bishop St #200" and "1420 Bishop St Ste 200" are the same tenancy written two ways, and left
 * un-canonicalised they compare as two different units — a false negative that costs a duplicate.
 *
 * `fl`/`floor` and `bldg`/`building` are deliberately NOT in here. A floor is not a suite: folding them
 * would make "Fl 2" and "Ste 2" the same space, which is a false MATCH, and those cost far more than a
 * duplicate.
 */
const UNIT_MARKER_CANONICAL: Record<string, string> = {
  ste: "unit", suite: "unit", unit: "unit",
  apt: "unit", apartment: "unit",
  rm: "unit", room: "unit",
};

/**
 * Split "1420 bishop street ste 200" into its building part and its unit part.
 *
 * Needed because the two sides of a real comparison are rarely written the same way: a legacy property
 * stores the tenancy ("1420 Bishop St Ste 200") and a reverse geocode returns the building ("1420
 * Bishop St"). Exact-key comparison rejects that pair, and distance cannot rescue it because the legacy
 * row has no coordinates — so the capture would report "no match" and mint a duplicate of a property
 * that is sitting right there. An earlier version of this file claimed distance covered this case; it
 * cannot, for exactly the rows where it matters most.
 */
export function splitUnit(key: string): { base: string; unit: string | null } {
  const tokens = key.split(" ").filter(Boolean);
  const at = findUnitIndex(tokens);
  if (at === -1) return { base: tokens.join(" "), unit: null };
  return { base: tokens.slice(0, at).join(" "), unit: tokens.slice(at).join(" ") };
}

/**
 * Index of the unit marker, or -1. Shared with normalizeAddressKey so the two agree on where a street
 * line ends — they disagreeing is how a street type stops being expanded in the right place.
 *
 * Scans from index 1 and requires a token after the marker, so a street literally named "Unit" cannot
 * swallow the house number and a dangling marker is not read as a unit.
 */
function findUnitIndex(tokens: string[]): number {
  for (let i = tokens.length - 2; i >= 1; i -= 1) {
    if (UNIT_MARKERS.has(tokens[i]!)) return i;
  }
  return -1;
}

export type AddressMatchQuality = "exact" | "base" | null;

/**
 * How strongly two street lines agree.
 *
 *   "exact" — same building, same unit (or neither has one).
 *   "base"  — same building, and AT MOST ONE side names a unit. Offered as a candidate for a human to
 *             confirm, never treated as certain.
 *   null    — different buildings, or two DIFFERENT units in the same building.
 *
 * The last clause is the one that matters: "Ste 200" and "Ste 400" are separate tenancies, and folding
 * them attaches one tenant's deals to another's record — invisible, and unrecoverable without an audit.
 * Missing a match only ever costs a duplicate, which is visible and mergeable. The asymmetry is why
 * "base" exists as its own weaker verdict instead of being rolled into "exact".
 */
export function compareAddressKeys(
  a: string | null | undefined,
  b: string | null | undefined
): AddressMatchQuality {
  const left = normalizeAddressKey(a);
  const right = normalizeAddressKey(b);
  if (!left || !right) return null;
  if (left === right) return "exact";

  const leftParts = splitUnit(left);
  const rightParts = splitUnit(right);
  if (!leftParts.base || leftParts.base !== rightParts.base) return null;
  // Both name a unit and the units differ — different tenancies, not a near-miss.
  if (leftParts.unit && rightParts.unit) return null;
  return "base";
}

/** Both parts must be present to claim an EXACT address match — an empty key equals every other one. */
export function addressKeysMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  return compareAddressKeys(a, b) === "exact";
}

/**
 * Does the locality CONTRADICT the address match?
 *
 * "100 Main St" exists in every city in the country, and an office spanning more than one of them would
 * otherwise see every copy match — outranking genuine proximity hits and, worse, filling the candidate
 * list so the capture never offers "add new" for the building actually underfoot.
 *
 * Framed as "cannot disprove" rather than "must agree", because legacy rows frequently have a null city
 * or state. Requiring equality would silently drop exactly the uncoordinated legacy properties this
 * matcher exists to find. So a match survives when either side is silent, and dies only on a real
 * disagreement.
 */
export function localityContradicts(
  query: { city?: string | null; state?: string | null; zip?: string | null },
  row: { city?: string | null; state?: string | null; zip?: string | null }
): boolean {
  // Punctuation-insensitive: Mapbox returns "St. Louis" where a legacy row stores "St Louis", and a
  // raw comparison calls that a CONTRADICTION — actively disproving a correct match and sending the
  // capture off to create a duplicate. Disproof has to be certain to be useful.
  const norm = (v: string | null | undefined) =>
    typeof v === "string" ? v.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() : "";
  const qCity = norm(query.city);
  const rCity = norm(row.city);
  if (qCity && rCity && qCity !== rCity) return true;
  const qState = norm(query.state);
  const rState = norm(row.state);
  if (qState && rState && qState !== rState) return true;
  // ZIP catches what city and state cannot: two "100 Main St" in the SAME city, in different postal
  // areas — a large city has several, and city+state agree on both.
  const qZip = norm(query.zip).slice(0, 5);
  const rZip = norm(row.zip).slice(0, 5);
  if (qZip && rZip && qZip !== rZip) return true;
  return false;
}

export interface PropertyMatchInput {
  lat?: number | null;
  lng?: number | null;
  address?: string | null;
  /** Used only to DISPROVE an address match — see localityContradicts. */
  city?: string | null;
  state?: string | null;
  zip?: string | null;
}

/**
 * The query address with street types ABBREVIATED rather than expanded — the shape a legacy row is
 * likely to hold. Used only to widen the candidate fetch, never to decide a match.
 */
function collapseSuffixes(key: string): string {
  const reverse: Record<string, string> = {};
  for (const [abbr, full] of Object.entries(STREET_TYPES)) {
    if (!(full in reverse)) reverse[full] = abbr;
  }
  return key
    .split(" ")
    .map((token) => reverse[token] ?? token)
    .join(" ");
}

function isFiniteCoordinate(value: unknown, limit: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= limit;
}

export async function matchProperties(
  tenantDb: TenantDb,
  input: PropertyMatchInput
): Promise<PropertyMatch[]> {
  const hasPoint = isFiniteCoordinate(input.lat, 90) && isFiniteCoordinate(input.lng, 180);
  const addressKey = normalizeAddressKey(input.address);
  // Nothing to match ON. Returning every property would be worse than returning none: the client would
  // offer an arbitrary building as "the one you're at".
  if (!hasPoint && !addressKey) return [];

  const lat = hasPoint ? (input.lat as number) : 0;
  const lng = hasPoint ? (input.lng as number) : 0;

  /**
   * Bounding box first, haversine second.
   *
   * There is no spatial index on this table, so the box is what keeps this from running trigonometry
   * over every property in the office. The longitude delta widens with latitude (degrees of longitude
   * shrink toward the poles); clamped because cos() collapses to zero at the pole and would produce an
   * infinite delta.
   */
  const latDelta = PROPERTY_MATCH_RADIUS_METERS / METERS_PER_DEGREE_LAT;
  const cosLat = Math.max(Math.cos((lat * Math.PI) / 180), 0.01);
  const lngDelta = PROPERTY_MATCH_RADIUS_METERS / (METERS_PER_DEGREE_LAT * cosLat);

  // Haversine, in metres, against the stored numeric columns.
  const distanceSql = sql`
    2 * 6371000 * asin(sqrt(
      power(sin(radians((p.lat::float8 - ${lat}) / 2)), 2) +
      cos(radians(${lat})) * cos(radians(p.lat::float8)) *
      power(sin(radians((p.lng::float8 - ${lng}) / 2)), 2)
    ))`;

  /**
   * The longitude band, WRAPPED at the antimeridian.
   *
   * A BETWEEN across ±180 is empty — at longitude 179.999 the band runs to 180.001, which no stored
   * value can satisfy, so a property 50 m away on the other side of the line is invisible and the
   * capture creates a duplicate. Rare, and free to handle correctly.
   */
  const lngLow = lng - lngDelta;
  const lngHigh = lng + lngDelta;
  const lngBand =
    lngLow < -180 || lngHigh > 180
      ? sql`(p.lng >= ${((lngLow + 180 + 360) % 360) - 180}::numeric OR p.lng <= ${((lngHigh + 180 + 360) % 360) - 180}::numeric)`
      : sql`p.lng BETWEEN ${lngLow}::numeric AND ${lngHigh}::numeric`;

  /**
   * The box compares NUMERIC to NUMERIC on purpose.
   *
   * Casting the column (`p.lat::float8`) makes the comparison an expression over `lat` rather than a
   * reference to it, and Postgres cannot then use the (lat, lng) index from migration 0201 — the query
   * would be indexed on paper and sequential in practice. The bound is cast instead of the column. The
   * haversine below keeps its float8 cast, because it only runs on rows the box already admitted.
   */
  const withinBox = hasPoint
    ? sql`(
        p.lat IS NOT NULL AND p.lng IS NOT NULL
        AND p.lat BETWEEN ${lat - latDelta}::numeric AND ${lat + latDelta}::numeric
        AND ${lngBand}
      )`
    : sql`false`;

  /**
   * SQL WIDENS, TypeScript DECIDES — and the split is not stylistic.
   *
   * The obvious shape is to normalise both sides in SQL and compare. It does not work: the suffix
   * expansion below lives in TS, so a stored "1420 Bishop St" would be compared against a query key of
   * "1420 bishop street" and never match — the exact duplicate this function exists to prevent, caused
   * by the function meant to prevent it. Reproducing STREET_SUFFIXES as a regexp_replace chain would
   * fix that by creating a second copy of the rule, and this codebase has paid for mirrored rules
   * repeatedly.
   *
   * So SQL fetches a generous CANDIDATE set on cheap predicates — inside the bounding box, or sharing
   * the leading house number — and `addressKeysMatch` makes the actual decision in one place.
   */
  /**
   * The candidate predicate collapses PUNCTUATION only — no suffix expansion, so it is not a second
   * copy of the matching rule. It exists so TypeScript gets a chance to decide.
   *
   * Matching on a bare `like '<digits> %'` against the raw column missed three real address shapes,
   * each of which then produced a duplicate because the distance branch cannot select an uncoordinated
   * row either: "12A Main St" (first token not all digits), "12-14 Main St" (punctuation inside the
   * number, so the raw prefix never matches), and street lines with no leading number at all.
   */
  const normalizedDbAddress = sql`
    btrim(regexp_replace(lower(coalesce(p.address, '')), '[^a-z0-9]+', ' ', 'g'))`;

  const leadToken = addressKey.split(" ")[0] ?? "";
  const sameLeadToken = leadToken
    ? sql`${normalizedDbAddress} like ${`${leadToken} %`}`
    : sql`false`;
  // A street line with no usable lead token still has a full form worth comparing — cheaper than
  // giving up and creating a duplicate. The punctuation-collapsed key is what the DB side can produce.
  const punctuationKey = (input.address ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  /**
   * Two forms, because the punctuation-only key misses the pair this matcher exists for.
   *
   * "100 Main Street" against a stored "100 Main St" differs by the very abbreviation
   * normalizeAddressKey canonicalises, so a punctuation-only comparison never fires — leaving that row
   * to reach TypeScript only via the lead-token predicate, which the candidate cap can cut. Comparing
   * the NORMALISED key too keeps it in front of the cap. Still not a mirror: this only promotes
   * candidates, and addressKeysMatch remains the sole decision.
   */
  /**
   * Three forms, because each misses a pair the others catch.
   *
   * The stored side is only punctuation-collapsed — no suffix expansion happens in SQL, by design. So
   * a query of "100 Main Street" against a stored "100 Main St" matches NEITHER the punctuation key
   * nor the normalised key: one side is expanded and the other is not. Comparing the query's
   * UNEXPANDED punctuation form against the stored text covers that direction, and comparing the
   * expanded key covers the reverse (stored "100 Main Street", query "100 Main St").
   *
   * Still not a mirror: all three only PROMOTE a row past the candidate cap. addressKeysMatch remains
   * the single decision about whether it is the same building.
   */
  const rawQueryKey = punctuationKey;
  const sameWholeAddress =
    rawQueryKey || addressKey
      ? sql`(
          ${normalizedDbAddress} = ${rawQueryKey}
          OR ${normalizedDbAddress} = ${addressKey}
          OR ${normalizedDbAddress} = ${collapseSuffixes(rawQueryKey)}
        )`
      : sql`false`;

  const rows = await tenantDb.execute(sql`
    select
      p.id,
      p.name,
      p.address,
      p.city,
      p.state,
      p.zip,
      p.company_id,
      c.name as company_name,
      case when ${withinBox} then ${distanceSql} else null end as distance_meters
    from properties p
    left join companies c on c.id = p.company_id
    where coalesce(p.is_test_data, false) = false
      -- Soft-deleted properties stay in this table with is_active = false. Offering one would attach a
      -- rep's visit to a retired record, and nothing in the response says it is retired.
      and p.is_active = true
      and (
        ${sameLeadToken}
        or ${sameWholeAddress}
        or (${withinBox} and ${distanceSql} <= ${PROPERTY_MATCH_RADIUS_METERS})
      )
    order by
      -- WHOLE-ADDRESS hits first, so the cap cannot discard the one row that would have matched.
      -- Without GPS every candidate scores the same 1e9 distance and falls back to name order, so on a
      -- street where 200+ properties share a lead token the exact address could sit past the limit —
      -- producing "nothing here" and a duplicate for a property that exists.
      (${sameWholeAddress}) desc,
      case when ${withinBox} then ${distanceSql} else 1e9 end asc,
      p.name asc
    limit ${CANDIDATE_LIMIT}
  `);

  const matches: PropertyMatch[] = [];
  for (const row of rows.rows as Array<Record<string, unknown>>) {
    const rawDistance = row.distance_meters;
    const numericDistance = rawDistance == null ? NaN : Number(rawDistance);
    const distanceMeters = Number.isFinite(numericDistance) ? Math.round(numericDistance) : null;

    // Locality can only DISPROVE. "100 Main St" in the next city over is a different building, and
    // without this it would outrank a genuine proximity hit at the address the rep is standing on.
    const contradicted = localityContradicts(input, {
      city: row.city as string | null,
      state: row.state as string | null,
      zip: row.zip as string | null,
    });
    const addressMatch = contradicted
      ? null
      : compareAddressKeys(input.address, row.address as string | null);
    const byAddress = addressMatch !== null;
    const byDistance = distanceMeters != null && distanceMeters <= PROPERTY_MATCH_RADIUS_METERS;
    // A candidate sharing only a lead token is a different street. Dropping it here is why SQL is
    // allowed to be generous above.
    if (!byAddress && !byDistance) continue;

    matches.push({
      addressMatch,
      id: String(row.id),
      name: String(row.name ?? ""),
      address: (row.address as string | null) ?? null,
      city: (row.city as string | null) ?? null,
      state: (row.state as string | null) ?? null,
      zip: (row.zip as string | null) ?? null,
      companyId: String(row.company_id),
      companyName: (row.company_name as string | null) ?? null,
      distanceMeters,
      reason: byAddress && byDistance ? "address+distance" : byAddress ? "address" : "distance",
    });
  }

  /**
   * An address match outranks proximity because it is the signal that survives a property with NO
   * coordinates — which, until this feature starts backfilling them, is most of the table. Sorting by
   * distance alone would bury the exact-address hit under whatever happens to be nearest.
   */
  // exact address, then same-building, then proximity. An exact hit must never sit below whatever
  // happens to be physically nearest — it is the signal that survives an uncoordinated legacy row.
  const rank = (m: PropertyMatch) =>
    m.addressMatch === "exact" ? 0 : m.addressMatch === "base" ? 1 : 2;
  matches.sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    return (a.distanceMeters ?? Number.MAX_SAFE_INTEGER) - (b.distanceMeters ?? Number.MAX_SAFE_INTEGER);
  });

  return matches.slice(0, PROPERTY_MATCH_LIMIT);
}
