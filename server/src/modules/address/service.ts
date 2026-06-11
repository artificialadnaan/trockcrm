export const ADDRESS_AUTOCOMPLETE_COUNTRY = "us"; // US-only by config; revisit if non-US properties are onboarded.
export const MAPBOX_REQUEST_TIMEOUT_MS = 3000;    // distinct from the client's 250ms input debounce.
export const SUGGEST_LIMIT = 5;
export const MIN_QUERY_LENGTH = 3;

const MAPBOX_V6_FORWARD = "https://api.mapbox.com/search/geocode/v6/forward";

export interface AddressSuggestion {
  id: string;
  label: string;
  address: string;
  city: string;
  state: string;
  zip: string;
}

interface MapboxFeature {
  id?: string;
  properties?: {
    full_address?: string;
    name?: string;
    context?: {
      place?: { name?: string };
      region?: { region_code?: string; name?: string };
      postcode?: { name?: string };
    };
  };
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
