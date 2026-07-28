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
 * Directionals in EITHER spelling, for the trailing-token test.
 *
 * `DIRECTIONALS` is keyed by abbreviation, so "100 Main St North" did not shift the type position —
 * `St` then fell through to the non-final alias and became "saint", giving "100 main saint north",
 * which matches nothing and least of all "100 Main Street North".
 */
const DIRECTIONAL_TOKENS = new Set([
  ...Object.keys(DIRECTIONALS),
  ...Object.values(DIRECTIONALS),
]);

/**
 * Spelled-out directional back to its abbreviation ("north" → "n").
 *
 * normalizeAddressKey only ever EXPANDS, so a numberless query written either way canonicalises to
 * "north main street" — and the stored row folds to "n main st". Both the canonical and the raw lead
 * token are therefore "north", and no whole-address form abbreviates a leading word (they collapse
 * street SUFFIXES), so the row was never fetched and the comparator never got to agree with it.
 */
const DIRECTIONAL_ABBREVIATIONS: Record<string, string> = Object.fromEntries(
  Object.entries(DIRECTIONALS).map(([abbr, full]) => [full, abbr]),
);

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
  const cleaned = foldDiacritics(value)
    .toLowerCase()
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
    // Route numbers are not always plain digits: "55 State Hwy 7A", "US 41B". Accepting only /^\d+$/
    // left `hwy` looking non-final, so it never expanded and "Hwy 7A" could not match "Highway 7A" —
    // and with both addresses non-empty the conflict rule then stopped GPS from recovering it either.
    const routeNumber = (s: string) => /^\d+[a-z]?$/.test(s);
    if ((DIRECTIONAL_TOKENS.has(last) || routeNumber(last)) && STREET_TYPES[prev]) typeIndex -= 1;
  }

  /**
   * A lone letter between the house number and the street type IS the street name.
   *
   * "100 E St" is E Street — a real street in more than one US city — not "100 East St". Expanding it
   * merges two distinct addresses, and a false match is the failure this file refuses to trade for a
   * missed one. A directional with a name after it ("100 N Main St") is unambiguous and still expands.
   */
  /**
   * A one-letter token immediately before the street type is the NAME, wherever it sits.
   *
   * Keying on index 1 assumed a house number came first, so a bare "E St" — no number — fell through
   * and expanded to "east street", merging it with "East St" again from the other direction.
   */
  const nameIndex = typeIndex - 1;
  const nameIsSingleLetter = nameIndex >= 0 && (tokens[nameIndex]?.length ?? 0) === 1;

  return tokens
    .map((token, index) => {
      if (index >= baseEnd) return UNIT_MARKER_CANONICAL[token] ?? token;
      if (index === typeIndex) return STREET_TYPES[token] ?? DIRECTIONALS[token] ?? token;
      if (index === nameIndex && nameIsSingleLetter) return token;
      return DIRECTIONALS[token] ?? NON_FINAL_ALIASES[token] ?? token;
    })
    .join(" ");
}

/**
 * FOLD accents rather than delete the letter, in one place.
 *
 * The punctuation strip turns any character outside [a-z0-9] into a space, so "Cañon" became "ca on" —
 * two tokens matching nothing, least of all a legacy row spelling it "Canon". Decompose, drop the
 * combining marks, keep the letter. Every TypeScript-side key goes through here so the raw candidate
 * key, the expanded address key and the locality comparison cannot drift apart — they already did once.
 */
export function foldDiacritics(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/**
 * The accented characters this folds, and what each becomes.
 *
 * SQL has no NFD. `unaccent` would, but it is an extension that would have to exist in every tenant
 * database, so this is an explicit translate() pair instead — long enough to cover the accents that
 * actually appear in US street names (Cañon, Peña, Muñoz, Cortés) rather than every codepoint.
 *
 * The TypeScript side folds with NFD, so without this the two disagreed exactly where it matters:
 * `regexp_replace` turned "Cañon Rd" into "ca on rd" while normalizeAddressKey produced "canon road",
 * and neither the lead-token nor the whole-address predicate could then select the row. An
 * uncoordinated legacy row is unreachable by distance too, so the capture reported "no match" and
 * minted a duplicate of a property that was sitting right there.
 */
const ACCENTED = "áàâäãåÁÀÂÄÃÅéèêëÉÈÊËíìîïÍÌÎÏóòôöõÓÒÔÖÕúùûüÚÙÛÜñÑçÇýÿÝ";
// Uppercase accents map to LOWERCASE ascii deliberately: the key is lowercase, and under a C collation
// lower() leaves non-ASCII alone, so this must not depend on lower() having folded them first.
const UNACCENTED = "aaaaaaaaaaaaeeeeeeeeiiiiiiiioooooooooouuuuuuuunnccyyy";

/**
 * ONE definition of the folded address column, shared by the query and by migration 0201's index.
 *
 * Postgres matches an expression index SYNTACTICALLY, so if these two strings ever differ by so much
 * as a character the index is silently ignored and the endpoint drops to a sequential scan with
 * nothing failing to say so. Generating both from this function is what makes that impossible; the
 * migration's runtime test asserts the index definition still contains it.
 */
export function FOLDED_ADDRESS_SQL(column: string): string {
  return `translate(lower(coalesce(${column}, '')), '${ACCENTED}', '${UNACCENTED}')`;
}

/**
 * How much of an address the index will hold.
 *
 * `properties.address` is unbounded text and no validator caps it, while a btree tuple cannot exceed
 * roughly 2.7 KB. One pasted or badly imported value above that aborts the migration outright — and,
 * once the index exists, every INSERT or UPDATE of such a row fails too. 512 is far past any real
 * street line and far below the limit.
 *
 * Truncation can only cost a MISS, never a false match: two addresses agreeing for 512 characters and
 * differing after are not something this file will ever see, and a miss costs a mergeable duplicate.
 */
const ADDRESS_INDEX_MAX_CHARS = 512;

/**
 * THE normalised-address expression — one definition for the query and for migration 0201's index.
 *
 * Postgres matches an expression index syntactically, so if these two ever differ by a character the
 * index is silently ignored and the endpoint drops to a sequential scan with nothing failing to say
 * so. Generating both from here is what makes that impossible.
 */
export function NORMALIZED_ADDRESS_SQL(column: string): string {
  return `left(btrim(regexp_replace(${FOLDED_ADDRESS_SQL(column)}, '[^a-z0-9]+', ' ', 'g')), ${ADDRESS_INDEX_MAX_CHARS})`;
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
  // One FAMILY, folded: a generic "#", "unit" and "ste"/"suite" all name the same commercial slot, and
  // this is a commercial-roofing CRM where suites dominate.
  ste: "unit", suite: "unit", unit: "unit",
  // Apartments and rooms keep their OWN tokens. Folding them in made "100 Main St Ste 200" and
  // "100 Main St Apt 200" identical — a false match between two spaces in a mixed-use building, which
  // is the failure this file trades everything else to avoid. Missing that pair costs a duplicate.
  apt: "apartment", apartment: "apartment",
  rm: "room", room: "room",
  // Folded to their OWN word, not to each other and not into "unit". "Bldg A" and "Building A" are the
  // same place written twice; left unmapped their base addresses agreed while their unit strings did
  // not, so compareAddressKeys returned null and the capture minted a duplicate. Keeping each family
  // separate is what stops "Fl 2" from ever equalling "Ste 2".
  fl: "floor", floor: "floor",
  bldg: "building", building: "building",
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
 * Full state names to their codes, because a legacy row and a geocode rarely agree on the form.
 *
 * "Texas" against Mapbox's "TX" compared as raw strings looks like a CONTRADICTION — and a
 * contradiction here is not a missed signal, it switches off both address and distance matching for
 * that row. So the one thing this file trades everything to avoid, a duplicate property, was produced
 * by two spellings of the same state. Codes are canonicalised in both directions before comparing.
 */
const STATE_CODES: Record<string, string> = {
  "alabama": "al",
  "alaska": "ak",
  "arizona": "az",
  "arkansas": "ar",
  "california": "ca",
  "colorado": "co",
  "connecticut": "ct",
  "delaware": "de",
  "district of columbia": "dc",
  "florida": "fl",
  "georgia": "ga",
  "hawaii": "hi",
  "idaho": "id",
  "illinois": "il",
  "indiana": "in",
  "iowa": "ia",
  "kansas": "ks",
  "kentucky": "ky",
  "louisiana": "la",
  "maine": "me",
  "maryland": "md",
  "massachusetts": "ma",
  "michigan": "mi",
  "minnesota": "mn",
  "mississippi": "ms",
  "missouri": "mo",
  "montana": "mt",
  "nebraska": "ne",
  "nevada": "nv",
  "new hampshire": "nh",
  "new jersey": "nj",
  "new mexico": "nm",
  "new york": "ny",
  "north carolina": "nc",
  "north dakota": "nd",
  "ohio": "oh",
  "oklahoma": "ok",
  "oregon": "or",
  "pennsylvania": "pa",
  "puerto rico": "pr",
  "rhode island": "ri",
  "south carolina": "sc",
  "south dakota": "sd",
  "tennessee": "tn",
  "texas": "tx",
  "utah": "ut",
  "vermont": "vt",
  "virginia": "va",
  "washington": "wa",
  "west virginia": "wv",
  "wisconsin": "wi",
  "wyoming": "wy",
};

/** A state in canonical two-letter form, whichever way it was written. */
function canonicalState(value: string): string {
  const v = value.trim().toLowerCase();
  return STATE_CODES[v] ?? v;
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
    typeof v === "string"
      ? // Same fold as the street line — "San José" and "San Jose" are one city, and deleting the
        // accent instead of folding it turns agreement into a CONTRADICTION, the worst direction for a
        // disproof rule to fail in. Shared helper, so the two sides cannot drift.
        foldDiacritics(v)
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, " ")
          .trim()
      : "";

  /**
   * Abbreviated place words, spelled out.
   *
   * Punctuation-insensitivity already handles "St. Louis" against "St Louis", but not against "Saint
   * Louis" — different TOKENS, so the comparison called one city two and disabled matching for the
   * row. Mirrors NON_FINAL_ALIASES on the street side, and for the same reason.
   */
  const CITY_ALIASES: Record<string, string> = {
    st: "saint",
    ste: "sainte",
    ft: "fort",
    mt: "mount",
    pt: "point",
  };
  const canonicalCity = (v: string) =>
    v
      .split(" ")
      .filter(Boolean)
      .map((tok) => CITY_ALIASES[tok] ?? tok)
      .join(" ");
  const qCity = canonicalCity(norm(query.city));
  const rCity = canonicalCity(norm(row.city));
  if (qCity && rCity && qCity !== rCity) return true;
  // Canonicalised, so "Texas" and "TX" are one state rather than a contradiction that would disable
  // matching for the row entirely.
  const qState = canonicalState(norm(query.state));
  const rState = canonicalState(norm(row.state));
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
   * The candidate predicate collapses PUNCTUATION and folds DIACRITICS only — no suffix expansion, so
   * it is not a second copy of the matching rule. It exists so TypeScript gets a chance to decide.
   *
   * Matching on a bare `like '<digits> %'` against the raw column missed three real address shapes,
   * each of which then produced a duplicate because the distance branch cannot select an uncoordinated
   * row either: "12A Main St" (first token not all digits), "12-14 Main St" (punctuation inside the
   * number, so the raw prefix never matches), and street lines with no leading number at all.
   */
  const normalizedDbAddress = sql`${sql.raw(NORMALIZED_ADDRESS_SQL("p.address"))}`;

  /**
   * The RAW query key folds accents too, or the two sides disagree again.
   *
   * The stored column is now folded in SQL, so "100 Peña Blvd" is indexed as "100 pena blvd" — but this
   * key was still built by stripping punctuation from the raw text, giving "100 pe a blvd". Neither
   * whole-address predicate then matched, leaving an uncoordinated legacy row reachable only through
   * the broad "100 %" lead-token scan, where the candidate cap can drop it on a street with many
   * properties sharing that house number. Same fold as normalizeAddressKey, same reason.
   */
  const punctuationKey = foldDiacritics(input.address ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

  /**
   * The lead token in BOTH spellings, because a numberless address starts with a word we expand.
   *
   * `normalizeAddressKey` canonicalises "North Main Street" to "north main street", so the lead token
   * is "north" — while the stored row folds to "n main st". Neither the `north %` prefix nor any
   * whole-address form (which only collapse street SUFFIXES) fetches it, so an uncoordinated row the
   * comparator would happily call equal was never a candidate at all, and the typed-address flow went
   * on to create a duplicate of it.
   */
  const leadToken = addressKey.split(" ")[0] ?? "";
  const rawLeadToken = (punctuationKey.split(" ")[0] ?? "").trim();
  const leadTokenVariants = [
    ...new Set(
      [
        leadToken,
        rawLeadToken,
        // The ABBREVIATED form, which is the only one a stored "N Main St" starts with.
        DIRECTIONAL_ABBREVIATIONS[leadToken],
        DIRECTIONAL_ABBREVIATIONS[rawLeadToken],
      ].filter(Boolean),
    ),
  ];
  const sameLeadToken = leadTokenVariants.length
    ? sql.join(
        leadTokenVariants.map((tok) => sql`${normalizedDbAddress} like ${`${tok} %`}`),
        sql` OR `,
      )
    : sql`false`;
  // A street line with no usable lead token still has a full form worth comparing — cheaper than
  // giving up and creating a duplicate. The punctuation-collapsed key is what the DB side can produce.
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

  /**
   * The stored row EXTENDS the queried building — the suite case, and the reason splitUnit exists.
   *
   * A geocode returns "100 Main St" while the legacy record stores "100 Main St Ste 200", so no
   * equality holds and the row is selected only by the office-wide "100 %" lead token. Ordered by name
   * after that, it can sit beyond the 200-candidate cap on any street where that many properties share
   * a house number — and TypeScript never sees the one row that would have matched, so the capture
   * offers to create a duplicate of it.
   *
   * A prefix test is deliberately cheap and generous: it only decides ORDERING here, and
   * addressKeysMatch still makes the real decision downstream.
   */
  const extendsQueriedAddress =
    rawQueryKey || addressKey
      ? sql`(
          ${normalizedDbAddress} LIKE ${`${rawQueryKey} %`}
          OR ${normalizedDbAddress} LIKE ${`${addressKey} %`}
          -- The COLLAPSED form too, mirroring the equality predicate above. A query written out in
          -- full ("100 Main Street") against a stored abbreviation ("100 Main St Ste 200") matched
          -- neither prefix, so a row compareAddressKeys would call a base match was ordered through
          -- the broad token set and could still fall past the cap.
          OR ${normalizedDbAddress} LIKE ${`${collapseSuffixes(rawQueryKey)} %`}
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
      -- A property whose COMPANY is soft-deleted is unusable, not merely unusual: deleteCompany flips
      -- only companies.is_active and leaves its properties active, while createLead requires an active
      -- company. Offering one hands the rep a candidate that matching accepts and promotion then
      -- rejects — and because a new property is offered only when matching comes back empty, that is a
      -- dead end rather than a slower path. Null company_id is fine; an INACTIVE one is not.
      and (p.company_id is null or c.is_active = true)
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
      -- Then rows that EXTEND the queried building ("... Ste 200"). Without this they were ordered by
      -- name alone and fell off the end of the cap, which is exactly how a suite-bearing legacy record
      -- gets duplicated by a building-level geocode.
      (${extendsQueriedAddress}) desc,
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

    /**
     * PROXIMITY MUST NOT OVERRULE A KNOWN CONFLICT.
     *
     * compareAddressKeys already refuses to fold "Ste 200" into "Ste 400" — and then distance let them
     * through anyway, because two tenancies in one tower are metres apart. Same for a locality that
     * actively disagrees: a stored "100 Main St, Austin" sitting inside the GPS box of a query for
     * "100 Main St, Dallas" is a data error, not a match.
     *
     * Distance is the RECOVERING signal, for rows whose address text cannot be compared. Where the text
     * CAN be compared and says no, that answer stands — otherwise the whole false-match asymmetry this
     * file is built on is undone by the weaker signal.
     */
    /**
     * A CONFLICT is a contradiction, not merely a difference.
     *
     * Treating every unequal address as a conflict switched the distance branch off for any row that
     * has an address at all — which is nearly all of them — so a property 40 m away whose stored text
     * is a typo, an old spelling, or the venue's name ("Palm Villas Clubhouse" vs "1420 Bishop St")
     * was fetched by the bounding box and then thrown away. That is the branch's entire purpose, and
     * the capture minted a duplicate of a building the rep was standing on.
     *
     * Two things genuinely contradict:
     *   - the LOCALITY disagrees — a different city, state or ZIP is a different place;
     *   - both sides name a unit and the units DIFFER — Ste 200 is not Ste 400.
     * Everything else is two spellings of an unknown, and proximity is allowed to speak. This stays
     * safe because a distance match is a SUGGESTION the rep confirms, shown with "40 m away" beside
     * it — not a silent merge.
     */
    const queryUnit = splitUnit(normalizeAddressKey(input.address)).unit;
    const rowUnit = splitUnit(normalizeAddressKey(row.address as string | null)).unit;
    const unitsContradict = queryUnit !== null && rowUnit !== null && queryUnit !== rowUnit;
    const addressesConflict = contradicted || unitsContradict;
    const byDistance =
      !addressesConflict && distanceMeters != null && distanceMeters <= PROPERTY_MATCH_RADIUS_METERS;
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
  /**
   * Corroboration outranks strength.
   *
   * An exact address match whose locality cannot be checked — the query names a city, the legacy row
   * has none — has NO second signal agreeing with it, and "100 Main St" exists in every city. Ranking
   * it purely on address strength let an uncorroborated hit sit above a nearby property that both the
   * address AND the coordinates agreed on, and with a capped list it could push that real one out.
   *
   * Still a candidate, deliberately: those uncoordinated legacy rows are what address matching exists
   * to recover. It simply stops being the FIRST answer offered.
   */
  const corroborated = (m: PropertyMatch) =>
    m.distanceMeters != null && m.distanceMeters <= PROPERTY_MATCH_RADIUS_METERS;
  /**
   * Corroborated FIRST, then strength — which is what the paragraph above always claimed and what the
   * ranking did not do. A base match the GPS agrees with is the building underfoot; an exact street
   * line with no locality and no coordinates is "100 Main St" in an unknown city. Ranking every exact
   * hit above every base one put the remote guess first, and with the list capped at eight it could
   * push the property actually underfoot off the end.
   */
  const rank = (m: PropertyMatch) => {
    if (m.addressMatch === "exact" && corroborated(m)) return 0;
    if (m.addressMatch === "base" && corroborated(m)) return 1;
    if (m.addressMatch === "exact") return 2;
    if (m.addressMatch === "base") return 3;
    return 4;
  };
  matches.sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    return (a.distanceMeters ?? Number.MAX_SAFE_INTEGER) - (b.distanceMeters ?? Number.MAX_SAFE_INTEGER);
  });

  return matches.slice(0, PROPERTY_MATCH_LIMIT);
}
