const GEOCODE_URL =
  "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress";

export interface GeocodedCoords {
  lat: number;
  lng: number;
}

async function attemptGeocode(addressLine: string): Promise<GeocodedCoords | null> {
  const params = new URLSearchParams({
    address: addressLine,
    benchmark: "Public_AR_Current",
    format: "json",
  });

  const response = await fetch(`${GEOCODE_URL}?${params.toString()}`, {
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`Census geocoder returned HTTP ${response.status}`);
  }

  const data = (await response.json()) as {
    result?: {
      addressMatches?: Array<{
        coordinates?: { x?: number; y?: number };
      }>;
    };
  };

  const match = data?.result?.addressMatches?.[0];
  const x = match?.coordinates?.x;
  const y = match?.coordinates?.y;

  if (x == null || y == null) {
    return null;
  }

  return { lat: y, lng: x };
}

/**
 * Geocode a property address using the free Census Bureau geocoder.
 * Returns coordinates or null on failure — never throws.
 * Retries up to 2 times with exponential backoff (500ms, 1000ms).
 */
export async function geocodeAddress(
  address: string,
  city: string,
  state: string,
  zip?: string | null,
): Promise<GeocodedCoords | null> {
  const parts = [address, city, state];
  if (zip) parts.push(zip);
  const addressLine = parts.join(", ");

  const delays = [500, 1000];

  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      const result = await attemptGeocode(addressLine);
      return result;
    } catch (err) {
      if (attempt < delays.length) {
        await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
      } else {
        console.error("[Geocode] All attempts failed:", err);
      }
    }
  }

  return null;
}
