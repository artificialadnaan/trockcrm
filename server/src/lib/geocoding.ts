import { Client } from "@googlemaps/google-maps-services-js";
import { and, eq, gte } from "drizzle-orm";
import { geocodingCache } from "@trock-crm/shared/schema";
import { db } from "../db.js";

const GOOGLE_GEOCODING_PROVIDER = "google_geocoding" as const;
const CACHE_TTL_DAYS = 90;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface FormattedComponents {
  street?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
}

export interface ReverseGeocodeResult {
  address: string | null;
  latitude: number;
  longitude: number;
  source: typeof GOOGLE_GEOCODING_PROVIDER;
  cached: boolean;
  formattedComponents?: FormattedComponents;
}

export interface GeocodingCacheRow {
  latitude: string;
  longitude: string;
  provider: typeof GOOGLE_GEOCODING_PROVIDER;
  address: string | null;
  formattedComponents: FormattedComponents | null;
  cachedAt: Date;
}

export interface GeocodingCacheStore {
  findFresh(
    latitude: string,
    longitude: string,
    provider: typeof GOOGLE_GEOCODING_PROVIDER,
    freshAfter: Date
  ): Promise<GeocodingCacheRow | null>;
  upsert(row: GeocodingCacheRow): Promise<void>;
}

export interface ReverseGeocodeDeps {
  cacheStore?: GeocodingCacheStore;
  googleClient?: Pick<Client, "reverseGeocode">;
  now?: () => Date;
  env?: Partial<Record<"GOOGLE_GEOCODING_API_KEY", string>>;
  logger?: Pick<Console, "error" | "warn">;
}

export class InvalidCoordinatesError extends Error {
  statusCode = 400;
  code = "INVALID_COORDINATES";

  constructor(message: string) {
    super(message);
    this.name = "InvalidCoordinatesError";
  }
}

export function isGoogleGeocodingConfigured(env: Partial<Record<"GOOGLE_GEOCODING_API_KEY", string>> = process.env): boolean {
  return Boolean(env.GOOGLE_GEOCODING_API_KEY?.trim());
}

export function roundCoordinateForGeocodingCache(value: number): number {
  // Five decimals is roughly 1.1m of latitude precision, enough to collapse
  // repeated field uploads without materially moving the visible address.
  return Number(value.toFixed(5));
}

function assertValidCoordinates(latitude: number, longitude: number): void {
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    throw new InvalidCoordinatesError("Latitude must be between -90 and 90.");
  }
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new InvalidCoordinatesError("Longitude must be between -180 and 180.");
  }
}

export function createGeocodingCacheStore(database: typeof db = db): GeocodingCacheStore {
  return {
    async findFresh(latitude, longitude, provider, freshAfter) {
      const [row] = await database
        .select()
        .from(geocodingCache)
        .where(and(
          eq(geocodingCache.latitude, latitude),
          eq(geocodingCache.longitude, longitude),
          eq(geocodingCache.provider, provider),
          gte(geocodingCache.cachedAt, freshAfter)
        ))
        .limit(1);

      return row ? {
        latitude: row.latitude,
        longitude: row.longitude,
        provider: GOOGLE_GEOCODING_PROVIDER,
        address: row.address,
        formattedComponents: row.formattedComponents ?? null,
        cachedAt: row.cachedAt,
      } : null;
    },
    async upsert(row) {
      await database
        .insert(geocodingCache)
        .values(row)
        .onConflictDoUpdate({
          target: [geocodingCache.latitude, geocodingCache.longitude, geocodingCache.provider],
          set: {
            address: row.address,
            formattedComponents: row.formattedComponents,
            cachedAt: row.cachedAt,
          },
        });
    },
  };
}

// Lazily instantiated (mirroring getGoogleClient below) instead of a module-load `const`. Building it at
// import time would evaluate createGeocodingCacheStore()'s `= db` default arg on every import of this module,
// forcing any test whose graph transitively reaches geocoding to add a `db` export to its db.js mock or crash
// at load. Deferring to first geocode keeps the same single instance without that import-time db dependency.
let defaultCacheStore: GeocodingCacheStore | null = null;

function getDefaultCacheStore(): GeocodingCacheStore {
  defaultCacheStore ??= createGeocodingCacheStore();
  return defaultCacheStore;
}

let defaultClient: Client | null = null;

function getGoogleClient(): Client {
  defaultClient ??= new Client({});
  return defaultClient;
}

function componentValue(components: any[], type: string, field: "long_name" | "short_name" = "long_name"): string | undefined {
  return components.find((component) => component.types?.includes(type))?.[field];
}

function parseFormattedComponents(components: any[] | undefined): FormattedComponents | null {
  if (!components?.length) return null;

  const streetNumber = componentValue(components, "street_number");
  const route = componentValue(components, "route", "short_name") ?? componentValue(components, "route");
  const street = [streetNumber, route].filter(Boolean).join(" ") || undefined;
  const parsed: FormattedComponents = {
    street,
    city: componentValue(components, "locality")
      ?? componentValue(components, "postal_town")
      ?? componentValue(components, "sublocality"),
    state: componentValue(components, "administrative_area_level_1", "short_name"),
    postalCode: componentValue(components, "postal_code", "short_name"),
    country: componentValue(components, "country", "short_name"),
  };

  return Object.values(parsed).some(Boolean) ? parsed : null;
}

function emptyResult(latitude: number, longitude: number): ReverseGeocodeResult {
  return {
    address: null,
    latitude,
    longitude,
    source: GOOGLE_GEOCODING_PROVIDER,
    cached: false,
  };
}

function isQuotaError(error: unknown): boolean {
  const maybe = error as { response?: { status?: number; data?: { status?: string } } };
  return maybe.response?.status === 429 || maybe.response?.data?.status === "OVER_QUERY_LIMIT";
}

export async function reverseGeocode(
  latitude: number,
  longitude: number,
  deps: ReverseGeocodeDeps = {}
): Promise<ReverseGeocodeResult> {
  assertValidCoordinates(latitude, longitude);

  const roundedLatitude = roundCoordinateForGeocodingCache(latitude);
  const roundedLongitude = roundCoordinateForGeocodingCache(longitude);
  const latitudeKey = roundedLatitude.toFixed(5);
  const longitudeKey = roundedLongitude.toFixed(5);
  const now = deps.now?.() ?? new Date();
  const freshAfter = new Date(now.getTime() - CACHE_TTL_DAYS * MS_PER_DAY);
  const cacheStore = deps.cacheStore ?? getDefaultCacheStore();
  const logger = deps.logger ?? console;

  const cached = await cacheStore.findFresh(latitudeKey, longitudeKey, GOOGLE_GEOCODING_PROVIDER, freshAfter);
  if (cached) {
    return {
      address: cached.address,
      latitude: roundedLatitude,
      longitude: roundedLongitude,
      source: GOOGLE_GEOCODING_PROVIDER,
      cached: true,
      ...(cached.formattedComponents ? { formattedComponents: cached.formattedComponents } : {}),
    };
  }

  const key = deps.env?.GOOGLE_GEOCODING_API_KEY ?? process.env.GOOGLE_GEOCODING_API_KEY;
  if (!key && !deps.googleClient) {
    logger.error("[geocoding] GOOGLE_GEOCODING_API_KEY is not configured", {
      latitude: roundedLatitude,
      longitude: roundedLongitude,
    });
    return emptyResult(roundedLatitude, roundedLongitude);
  }
  const googleClient = deps.googleClient ?? getGoogleClient();

  try {
    const response = await googleClient.reverseGeocode({
      params: {
        key: key ?? "test-key",
        latlng: { lat: roundedLatitude, lng: roundedLongitude },
      },
    });

    const status = response.data.status;
    if (status === "OVER_QUERY_LIMIT") {
      logger.warn("[geocoding] Google quota or rate limit reached", {
        latitude: roundedLatitude,
        longitude: roundedLongitude,
        status,
      });
      return emptyResult(roundedLatitude, roundedLongitude);
    }

    if (status === "ZERO_RESULTS") {
      await cacheStore.upsert({
        latitude: latitudeKey,
        longitude: longitudeKey,
        provider: GOOGLE_GEOCODING_PROVIDER,
        address: null,
        formattedComponents: null,
        cachedAt: now,
      });
      return emptyResult(roundedLatitude, roundedLongitude);
    }

    if (status !== "OK") {
      logger.error("[geocoding] Google returned an unexpected status", {
        latitude: roundedLatitude,
        longitude: roundedLongitude,
        status,
      });
      return emptyResult(roundedLatitude, roundedLongitude);
    }

    const firstResult = response.data.results?.[0];
    const address = firstResult?.formatted_address ?? null;
    const formattedComponents = parseFormattedComponents(firstResult?.address_components);
    await cacheStore.upsert({
      latitude: latitudeKey,
      longitude: longitudeKey,
      provider: GOOGLE_GEOCODING_PROVIDER,
      address,
      formattedComponents,
      cachedAt: now,
    });

    return {
      address,
      latitude: roundedLatitude,
      longitude: roundedLongitude,
      source: GOOGLE_GEOCODING_PROVIDER,
      cached: false,
      ...(formattedComponents ? { formattedComponents } : {}),
    };
  } catch (error) {
    if (isQuotaError(error)) {
      logger.warn("[geocoding] Google quota or rate limit reached", {
        latitude: roundedLatitude,
        longitude: roundedLongitude,
        error,
      });
      return emptyResult(roundedLatitude, roundedLongitude);
    }

    // Upload confirmation should not fail when geocoding is unavailable. A
    // future worker job will retry/backfill records that fall back to deal data.
    logger.error("[geocoding] Reverse geocoding failed", {
      latitude: roundedLatitude,
      longitude: roundedLongitude,
      error,
    });
    return emptyResult(roundedLatitude, roundedLongitude);
  }
}
