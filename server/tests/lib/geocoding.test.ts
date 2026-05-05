import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createGeocodingCacheStore,
  InvalidCoordinatesError,
  isGoogleGeocodingConfigured,
  reverseGeocode,
  roundCoordinateForGeocodingCache,
  type GeocodingCacheStore,
} from "../../src/lib/geocoding.js";

function cacheStore(row: Awaited<ReturnType<GeocodingCacheStore["findFresh"]>> = null): GeocodingCacheStore {
  return {
    findFresh: vi.fn(async () => row),
    upsert: vi.fn(async () => undefined),
  };
}

function googleClient(data: any) {
  return {
    reverseGeocode: vi.fn(async () => ({ data })),
  };
}

describe("reverseGeocode", () => {
  const now = new Date("2026-05-05T12:00:00.000Z");

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a fresh cached result without calling Google", async () => {
    const store = cacheStore({
      latitude: "32.77666",
      longitude: "-96.79699",
      provider: "google_geocoding",
      address: "100 Main St, Dallas, TX 75201, USA",
      formattedComponents: { street: "100 Main St", city: "Dallas", state: "TX", postalCode: "75201", country: "US" },
      cachedAt: now,
    });
    const client = googleClient({ status: "OK", results: [] });

    const result = await reverseGeocode(32.776664, -96.796987, { cacheStore: store, googleClient: client, now: () => now });

    expect(result).toEqual({
      address: "100 Main St, Dallas, TX 75201, USA",
      latitude: 32.77666,
      longitude: -96.79699,
      source: "google_geocoding",
      cached: true,
      formattedComponents: { street: "100 Main St", city: "Dallas", state: "TX", postalCode: "75201", country: "US" },
    });
    expect(client.reverseGeocode).not.toHaveBeenCalled();
  });

  it("calls Google on cache miss, upserts the result, and returns it uncached", async () => {
    const store = cacheStore();
    const client = googleClient({
      status: "OK",
      results: [{
        formatted_address: "100 Main St, Dallas, TX 75201, USA",
        address_components: [
          { long_name: "100", short_name: "100", types: ["street_number"] },
          { long_name: "Main Street", short_name: "Main St", types: ["route"] },
          { long_name: "Dallas", short_name: "Dallas", types: ["locality"] },
          { long_name: "Texas", short_name: "TX", types: ["administrative_area_level_1"] },
          { long_name: "75201", short_name: "75201", types: ["postal_code"] },
          { long_name: "United States", short_name: "US", types: ["country"] },
        ],
      }],
    });

    const result = await reverseGeocode(32.776664, -96.796987, { cacheStore: store, googleClient: client, now: () => now });

    expect(client.reverseGeocode).toHaveBeenCalledWith({
      params: {
        key: expect.any(String),
        latlng: { lat: 32.77666, lng: -96.79699 },
      },
    });
    expect(store.upsert).toHaveBeenCalledWith({
      latitude: "32.77666",
      longitude: "-96.79699",
      provider: "google_geocoding",
      address: "100 Main St, Dallas, TX 75201, USA",
      formattedComponents: { street: "100 Main St", city: "Dallas", state: "TX", postalCode: "75201", country: "US" },
      cachedAt: now,
    });
    expect(result.cached).toBe(false);
    expect(result.address).toBe("100 Main St, Dallas, TX 75201, USA");
  });

  it("caches zero-result lookups as negative results", async () => {
    const store = cacheStore();
    const result = await reverseGeocode(0.123456, 10.987654, {
      cacheStore: store,
      googleClient: googleClient({ status: "ZERO_RESULTS", results: [] }),
      now: () => now,
    });

    expect(result.address).toBeNull();
    expect(store.upsert).toHaveBeenCalledWith(expect.objectContaining({
      latitude: "0.12346",
      longitude: "10.98765",
      address: null,
      formattedComponents: null,
    }));
  });

  it("returns null address on network failure without throwing", async () => {
    const store = cacheStore();
    const logger = { error: vi.fn(), warn: vi.fn() };
    const result = await reverseGeocode(32, -97, {
      cacheStore: store,
      googleClient: { reverseGeocode: vi.fn(async () => { throw new Error("network down"); }) },
      logger,
      now: () => now,
    });

    expect(result.address).toBeNull();
    expect(logger.error).toHaveBeenCalled();
    expect(store.upsert).not.toHaveBeenCalled();
  });

  it("returns null address on quota errors and logs a warning", async () => {
    const store = cacheStore();
    const logger = { error: vi.fn(), warn: vi.fn() };
    const result = await reverseGeocode(32, -97, {
      cacheStore: store,
      googleClient: googleClient({ status: "OVER_QUERY_LIMIT", results: [] }),
      logger,
      now: () => now,
    });

    expect(result.address).toBeNull();
    expect(logger.warn).toHaveBeenCalled();
    expect(store.upsert).not.toHaveBeenCalled();
  });

  it("returns null address on thrown Google 429 errors and logs a warning", async () => {
    const logger = { error: vi.fn(), warn: vi.fn() };
    const error = { response: { status: 429, data: { status: "OVER_QUERY_LIMIT" } } };

    const result = await reverseGeocode(32, -97, {
      cacheStore: cacheStore(),
      googleClient: { reverseGeocode: vi.fn(async () => { throw error; }) },
      logger,
      now: () => now,
    });

    expect(result.address).toBeNull();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("logs unexpected Google statuses without caching them", async () => {
    const store = cacheStore();
    const logger = { error: vi.fn(), warn: vi.fn() };

    const result = await reverseGeocode(32, -97, {
      cacheStore: store,
      googleClient: googleClient({ status: "REQUEST_DENIED", results: [] }),
      logger,
      now: () => now,
    });

    expect(result.address).toBeNull();
    expect(logger.error).toHaveBeenCalled();
    expect(store.upsert).not.toHaveBeenCalled();
  });

  it("throws a typed error for invalid coordinates", async () => {
    await expect(reverseGeocode(91, -97, { cacheStore: cacheStore(), googleClient: googleClient({}) }))
      .rejects.toBeInstanceOf(InvalidCoordinatesError);
    await expect(reverseGeocode(32, -181, { cacheStore: cacheStore(), googleClient: googleClient({}) }))
      .rejects.toBeInstanceOf(InvalidCoordinatesError);
  });

  it("reports whether the Google geocoding API key is configured", () => {
    expect(isGoogleGeocodingConfigured({ GOOGLE_GEOCODING_API_KEY: " test " })).toBe(true);
    expect(isGoogleGeocodingConfigured({ GOOGLE_GEOCODING_API_KEY: " " })).toBe(false);
  });

  it("rounds coordinates to five decimal places for cache keys", () => {
    expect(roundCoordinateForGeocodingCache(32.776664)).toBe(32.77666);
    expect(roundCoordinateForGeocodingCache(-96.796987)).toBe(-96.79699);
  });

  it("uses a 90-day freshness cutoff for cache lookups", async () => {
    const store = cacheStore();
    await reverseGeocode(32, -97, { cacheStore: store, googleClient: googleClient({ status: "ZERO_RESULTS", results: [] }), now: () => now });

    expect(store.findFresh).toHaveBeenCalledWith("32.00000", "-97.00000", "google_geocoding", new Date("2026-02-04T12:00:00.000Z"));
  });

  it("creates a Drizzle-backed cache store for reads and upserts", async () => {
    const row = {
      latitude: "32.00000",
      longitude: "-97.00000",
      provider: "google_geocoding",
      address: "Cached address",
      formattedComponents: null,
      cachedAt: now,
    };
    const limit = vi.fn(async () => [row]);
    const where = vi.fn(() => ({ limit }));
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));
    const onConflictDoUpdate = vi.fn(async () => undefined);
    const values = vi.fn(() => ({ onConflictDoUpdate }));
    const insert = vi.fn(() => ({ values }));
    const store = createGeocodingCacheStore({ select, insert } as any);

    await expect(store.findFresh("32.00000", "-97.00000", "google_geocoding", now)).resolves.toEqual(row);
    await store.upsert(row);

    expect(select).toHaveBeenCalled();
    expect(from).toHaveBeenCalled();
    expect(where).toHaveBeenCalled();
    expect(insert).toHaveBeenCalled();
    expect(values).toHaveBeenCalledWith(row);
    expect(onConflictDoUpdate).toHaveBeenCalled();
  });
});
