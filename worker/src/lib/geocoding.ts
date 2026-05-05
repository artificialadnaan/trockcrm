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
  // Five decimals is roughly 1.1m of latitude precision for cache keys.
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

const defaultCacheStore = createGeocodingCacheStore();

let defaultClient: Client | null = null;

function getGoogleClient(): Client {
  defaultClient ??= new Client({});
  return defaultClient;
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
  const cacheStore = deps.cacheStore ?? defaultCacheStore;
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

  try {
    const key = deps.env?.GOOGLE_GEOCODING_API_KEY ?? process.env.GOOGLE_GEOCODING_API_KEY;
    if (!key && !deps.googleClient) {
      deps.logger?.error("[geocoding] GOOGLE_GEOCODING_API_KEY is not configured", { latitude: roundedLatitude, longitude: roundedLongitude });
      return emptyResult(roundedLatitude, roundedLongitude);
    }

    const response = await (deps.googleClient ?? getGoogleClient()).reverseGeocode({
      params: {
        key: key ?? "test-key",
        latlng: { lat: roundedLatitude, lng: roundedLongitude },
      },
    });

    if (response.data.status === "OVER_QUERY_LIMIT") {
      deps.logger?.warn("[geocoding] Google quota or rate limit reached", { latitude: roundedLatitude, longitude: roundedLongitude });
      return emptyResult(roundedLatitude, roundedLongitude);
    }

    if (response.data.status === "ZERO_RESULTS") {
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

    const firstResult = response.data.results?.[0];
    const address = firstResult?.formatted_address ?? null;
    await cacheStore.upsert({
      latitude: latitudeKey,
      longitude: longitudeKey,
      provider: GOOGLE_GEOCODING_PROVIDER,
      address,
      formattedComponents: null,
      cachedAt: now,
    });

    return {
      address,
      latitude: roundedLatitude,
      longitude: roundedLongitude,
      source: GOOGLE_GEOCODING_PROVIDER,
      cached: false,
    };
  } catch (error) {
    deps.logger?.error("[geocoding] Reverse geocoding failed", { latitude: roundedLatitude, longitude: roundedLongitude, error });
    return emptyResult(roundedLatitude, roundedLongitude);
  }
}
