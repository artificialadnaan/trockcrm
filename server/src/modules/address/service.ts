export const ADDRESS_AUTOCOMPLETE_COUNTRY = "us"; // US-only by config; revisit if non-US properties are onboarded.
export const MAPBOX_REQUEST_TIMEOUT_MS = 3000;    // distinct from the client's 250ms input debounce.
export const SUGGEST_LIMIT = 5;
export const MIN_QUERY_LENGTH = 3;

const MAPBOX_V6_FORWARD = "https://api.mapbox.com/search/geocode/v6/forward";
const MAPBOX_V6_REVERSE = "https://api.mapbox.com/search/geocode/v6/reverse";

export interface AddressSuggestion {
  id: string;
  label: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  /**
   * Present when Mapbox returned a geometry — always on reverse, usually on forward.
   *
   * Carried because `properties.lat/lng` exist in the schema and nothing on the write path has ever
   * populated them: a property created through the API has null coordinates forever. That is what makes
   * a distance-only "find the property I'm standing at" unworkable — the building a rep logs today
   * would not match for the rep who visits it tomorrow. Handing the coordinates back with the address
   * lets the caller store them, so the data heals as it is used.
   */
  lat?: number;
  lng?: number;
}

interface MapboxFeature {
  id?: string;
  geometry?: { coordinates?: unknown };
  properties?: {
    full_address?: string;
    name?: string;
    coordinates?: { longitude?: unknown; latitude?: unknown };
    context?: {
      place?: { name?: string };
      region?: { region_code?: string; name?: string };
      postcode?: { name?: string };
    };
  };
}

/**
 * Mapbox reports coordinates in TWO places and GeoJSON order is [lng, lat] — reversed from how every
 * caller says it. Read once, here, rather than at each call site.
 */
function readCoordinates(raw: MapboxFeature): { lat?: number; lng?: number } {
  const geo = raw?.geometry?.coordinates;
  if (Array.isArray(geo) && geo.length >= 2) {
    const [lng, lat] = geo;
    if (isFiniteCoordinate(lat, 90) && isFiniteCoordinate(lng, 180)) return { lat, lng };
  }
  const p = raw?.properties?.coordinates;
  const lat = p?.latitude;
  const lng = p?.longitude;
  if (isFiniteCoordinate(lat, 90) && isFiniteCoordinate(lng, 180)) return { lat, lng };
  return {};
}

/** Finite, in range, and a real number — `null` is typeof "object", `NaN` passes a bare typeof check. */
function isFiniteCoordinate(value: unknown, limit: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= limit;
}

export function parseMapboxFeatures(data: unknown): AddressSuggestion[] {
  const features = (data as { features?: unknown })?.features;
  if (!Array.isArray(features)) return [];
  return features.map((raw: MapboxFeature) => {
    const p = raw?.properties ?? {};
    const address = (p.name ?? "").trim();
    return {
      id: String(raw?.id ?? address),
      label: (p.full_address ?? p.name ?? "").trim(),
      address,
      city: (p.context?.place?.name ?? "").trim(),
      state: (p.context?.region?.region_code ?? "").trim().toUpperCase(),
      zip: (p.context?.postcode?.name ?? "").trim(),
      ...readCoordinates(raw),
    };
  }).filter((s) => s.address.length > 0);
}

export async function suggestAddresses(query: string): Promise<AddressSuggestion[]> {
  const token = process.env.MAPBOX_TOKEN?.trim();
  const q = query.trim();
  if (!token) return [];                       // degrade: no token
  if (q.length < MIN_QUERY_LENGTH) return [];  // degrade: too short (no network call)
  const params = new URLSearchParams({
    q,
    autocomplete: "true",
    types: "address",
    country: ADDRESS_AUTOCOMPLETE_COUNTRY,
    limit: String(SUGGEST_LIMIT),
    // permanent=true: results are persisted to the property record (Mapbox ToS requires it for storage).
    permanent: "true",
    access_token: token,
  });
  try {
    const response = await fetch(`${MAPBOX_V6_FORWARD}?${params.toString()}`, {
      signal: AbortSignal.timeout(MAPBOX_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return [];               // degrade: non-2xx
    return parseMapboxFeatures(await response.json());
  } catch {
    return [];                                 // degrade: timeout / network error
  }
}

/**
 * Reverse geocode — "what building am I standing at?".
 *
 * The prospecting capture's anchor. `activities.source_entity_type/id` are NOT NULL, so a field log has
 * to attach to something; standing at a property is what supplies that something, which makes this the
 * structural piece rather than a convenience.
 *
 * DEGRADES LIKE suggestAddresses — returns null rather than throwing, for a missing token, a bad
 * coordinate, a non-2xx, or a timeout. A rep out of signal must get the manual address picker, not an
 * error screen: the whole point is capturing the visit while they are standing there.
 *
 * `permanent=true` for the same reason the forward call sets it — the result is persisted onto a
 * property record, and Mapbox's terms require the permanent endpoint for stored results.
 */
export async function reverseGeocode(lat: unknown, lng: unknown): Promise<AddressSuggestion | null> {
  const token = process.env.MAPBOX_TOKEN?.trim();
  if (!token) return null;
  // Validated HERE rather than trusted from the route: NaN and null both survive a bare typeof check,
  // and a malformed coordinate must no-match rather than be silently dropped into a Mapbox query.
  if (!isFiniteCoordinate(lat, 90) || !isFiniteCoordinate(lng, 180)) return null;

  const params = new URLSearchParams({
    longitude: String(lng),
    latitude: String(lat),
    types: "address",
    limit: "1",
    permanent: "true",
    access_token: token,
  });
  try {
    const response = await fetch(`${MAPBOX_V6_REVERSE}?${params.toString()}`, {
      signal: AbortSignal.timeout(MAPBOX_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const [first] = parseMapboxFeatures(await response.json());
    if (!first) return null;
    // Fall back to the CALLER's coordinates when Mapbox returns an address without geometry. The point
    // of this call is to end up with both an address and a position; dropping the position we already
    // had would leave the created property uncoordinated, which is the defect this exists to stop.
    return { ...first, lat: first.lat ?? lat, lng: first.lng ?? lng };
  } catch {
    return null;
  }
}
