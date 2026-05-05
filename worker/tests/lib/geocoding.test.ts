import { describe, expect, it, vi } from "vitest";
import {
  createGeocodingCacheStore,
  InvalidCoordinatesError,
  isGoogleGeocodingConfigured,
  reverseGeocode,
  roundCoordinateForGeocodingCache,
} from "../../src/lib/geocoding.js";

describe("worker geocoding wrapper", () => {
  it("reads GOOGLE_GEOCODING_API_KEY from the worker environment", () => {
    expect(isGoogleGeocodingConfigured({ GOOGLE_GEOCODING_API_KEY: "test-key" })).toBe(true);
    expect(isGoogleGeocodingConfigured({})).toBe(false);
  });

  it("can call reverseGeocode with worker dependencies", async () => {
    const result = await reverseGeocode(32, -97, {
      cacheStore: {
        findFresh: vi.fn(async () => null),
        upsert: vi.fn(async () => undefined),
      },
      googleClient: {
        reverseGeocode: vi.fn(async () => ({ data: { status: "ZERO_RESULTS", results: [] } })),
      },
      now: () => new Date("2026-05-05T12:00:00.000Z"),
    });

    expect(result).toMatchObject({
      address: null,
      source: "google_geocoding",
      cached: false,
    });
  });

  it("returns cached worker results without calling Google", async () => {
    const googleClient = { reverseGeocode: vi.fn() };
    const result = await reverseGeocode(32.123456, -97.123456, {
      cacheStore: {
        findFresh: vi.fn(async () => ({
          latitude: "32.12346",
          longitude: "-97.12346",
          provider: "google_geocoding",
          address: "Cached worker address",
          formattedComponents: { city: "Dallas" },
          cachedAt: new Date(),
        })),
        upsert: vi.fn(),
      },
      googleClient,
    });

    expect(result.cached).toBe(true);
    expect(result.formattedComponents).toEqual({ city: "Dallas" });
    expect(googleClient.reverseGeocode).not.toHaveBeenCalled();
  });

  it("upserts Google addresses and handles quota/network failures without throwing", async () => {
    const store = {
      findFresh: vi.fn(async () => null),
      upsert: vi.fn(async () => undefined),
    };
    await expect(reverseGeocode(32, -97, {
      cacheStore: store,
      googleClient: { reverseGeocode: vi.fn(async () => ({ data: { status: "OK", results: [{ formatted_address: "Worker address" }] } })) },
    })).resolves.toMatchObject({ address: "Worker address", cached: false });
    expect(store.upsert).toHaveBeenCalledWith(expect.objectContaining({ address: "Worker address" }));

    await expect(reverseGeocode(32, -97, {
      cacheStore: { findFresh: vi.fn(async () => null), upsert: vi.fn() },
      googleClient: { reverseGeocode: vi.fn(async () => ({ data: { status: "OVER_QUERY_LIMIT", results: [] } })) },
      logger: { error: vi.fn(), warn: vi.fn() },
    })).resolves.toMatchObject({ address: null });

    await expect(reverseGeocode(32, -97, {
      cacheStore: { findFresh: vi.fn(async () => null), upsert: vi.fn() },
      googleClient: { reverseGeocode: vi.fn(async () => { throw new Error("offline"); }) },
      logger: { error: vi.fn(), warn: vi.fn() },
    })).resolves.toMatchObject({ address: null });
  });

  it("validates worker coordinates and rounds cache keys", async () => {
    await expect(reverseGeocode(Number.NaN, -97, {
      cacheStore: { findFresh: vi.fn(), upsert: vi.fn() },
      googleClient: { reverseGeocode: vi.fn() },
    })).rejects.toBeInstanceOf(InvalidCoordinatesError);
    await expect(reverseGeocode(32, 181, {
      cacheStore: { findFresh: vi.fn(), upsert: vi.fn() },
      googleClient: { reverseGeocode: vi.fn() },
    })).rejects.toBeInstanceOf(InvalidCoordinatesError);
    expect(roundCoordinateForGeocodingCache(32.123456)).toBe(32.12346);
  });

  it("creates a Drizzle-backed worker cache store", async () => {
    const row = {
      latitude: "32.00000",
      longitude: "-97.00000",
      provider: "google_geocoding",
      address: "Worker cached address",
      formattedComponents: null,
      cachedAt: new Date("2026-05-05T12:00:00.000Z"),
    };
    const limit = vi.fn(async () => [row]);
    const where = vi.fn(() => ({ limit }));
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));
    const onConflictDoUpdate = vi.fn(async () => undefined);
    const values = vi.fn(() => ({ onConflictDoUpdate }));
    const insert = vi.fn(() => ({ values }));
    const store = createGeocodingCacheStore({ select, insert } as any);

    await expect(store.findFresh("32.00000", "-97.00000", "google_geocoding", row.cachedAt)).resolves.toEqual(row);
    await store.upsert(row);
    expect(values).toHaveBeenCalledWith(row);
    expect(onConflictDoUpdate).toHaveBeenCalled();
  });
});
