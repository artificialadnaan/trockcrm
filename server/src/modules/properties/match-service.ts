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
}

/**
 * Common US street-suffix abbreviations, expanded to one canonical form.
 *
 * "1420 Bishop Street" and "1420 Bishop St" are the same building and differ by four characters, which
 * is precisely how the existing duplicates were made. Deliberately SHORT: every entry is a claim that
 * two spellings mean the same thing, and a wrong claim silently merges two real buildings — a worse
 * failure than missing a match, because the rep cannot see it happen.
 */
const STREET_SUFFIXES: Record<string, string> = {
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
  n: "north", s: "south", e: "east", w: "west",
  ne: "northeast", nw: "northwest", se: "southeast", sw: "southwest",
};

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
    .replace(/[.,#]/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  return cleaned
    .split(" ")
    .map((token) => STREET_SUFFIXES[token] ?? token)
    .join(" ");
}

/** Both parts must be present to claim an address match — an empty key equals every other empty key. */
export function addressKeysMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = normalizeAddressKey(a);
  const right = normalizeAddressKey(b);
  return left.length > 0 && left === right;
}

export interface PropertyMatchInput {
  lat?: number | null;
  lng?: number | null;
  address?: string | null;
  city?: string | null;
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

  const withinBox = hasPoint
    ? sql`(
        p.lat IS NOT NULL AND p.lng IS NOT NULL
        AND p.lat::float8 BETWEEN ${lat - latDelta} AND ${lat + latDelta}
        AND p.lng::float8 BETWEEN ${lng - lngDelta} AND ${lng + lngDelta}
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
  const houseNumber = addressKey.split(" ")[0] ?? "";
  const sameHouseNumber = /^\d+$/.test(houseNumber)
    ? sql`lower(coalesce(p.address, '')) like ${`${houseNumber} %`}`
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
      and (
        ${sameHouseNumber}
        or (${withinBox} and ${distanceSql} <= ${PROPERTY_MATCH_RADIUS_METERS})
      )
    order by case when ${withinBox} then ${distanceSql} else 1e9 end asc, p.name asc
    limit ${CANDIDATE_LIMIT}
  `);

  const matches: PropertyMatch[] = [];
  for (const row of rows.rows as Array<Record<string, unknown>>) {
    const rawDistance = row.distance_meters;
    const numericDistance = rawDistance == null ? NaN : Number(rawDistance);
    const distanceMeters = Number.isFinite(numericDistance) ? Math.round(numericDistance) : null;

    const byAddress = addressKeysMatch(input.address, row.address as string | null);
    const byDistance = distanceMeters != null && distanceMeters <= PROPERTY_MATCH_RADIUS_METERS;
    // A candidate that shares a house number and nothing else is a different street. Dropping it here
    // is why SQL is allowed to be generous above.
    if (!byAddress && !byDistance) continue;

    matches.push({
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
  const rank = (m: PropertyMatch) => (m.reason === "distance" ? 1 : 0);
  matches.sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    return (a.distanceMeters ?? Number.MAX_SAFE_INTEGER) - (b.distanceMeters ?? Number.MAX_SAFE_INTEGER);
  });

  return matches.slice(0, PROPERTY_MATCH_LIMIT);
}
