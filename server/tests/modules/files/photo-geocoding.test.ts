import { describe, expect, it, vi } from "vitest";
import { resolvePhotoAddressMetadata, type PhotoAddressTenantDb } from "../../../src/modules/files/photo-geocoding.js";

function tenantDbWithDealAddress(addressRow: Record<string, unknown> | null): PhotoAddressTenantDb {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (addressRow ? [addressRow] : []),
        }),
      }),
    }),
  } as unknown as PhotoAddressTenantDb;
}

describe("photo upload geocoding integration", () => {
  it("reverse-geocodes EXIF coordinates and persists the client address source", async () => {
    const reverseGeocode = vi.fn(async () => ({
      address: "100 Main St, Dallas, TX 75201, USA",
      latitude: 32.77666,
      longitude: -96.79699,
      source: "google_geocoding" as const,
      cached: false,
    }));

    const result = await resolvePhotoAddressMetadata(
      tenantDbWithDealAddress(null),
      { dealId: "deal-1" },
      { latitude: 32.776664, longitude: -96.796987, addressSource: "exif" },
      { reverseGeocode, now: () => new Date("2026-05-05T12:00:00.000Z") }
    );

    expect(reverseGeocode).toHaveBeenCalledWith(32.776664, -96.796987);
    expect(result).toEqual({
      latitude: "32.7766640",
      longitude: "-96.7969870",
      geoLat: "32.776664",
      geoLng: "-96.796987",
      address: "100 Main St, Dallas, TX 75201, USA",
      addressSource: "exif",
      geocodedAt: new Date("2026-05-05T12:00:00.000Z"),
    });
  });

  it("reverse-geocodes live GPS coordinates and persists the live_gps source", async () => {
    const result = await resolvePhotoAddressMetadata(
      tenantDbWithDealAddress(null),
      { dealId: "deal-1" },
      { latitude: 32.7, longitude: -96.8, addressSource: "live_gps" },
      {
        reverseGeocode: vi.fn(async () => ({
          address: "200 Live Oak St, Dallas, TX 75202, USA",
          latitude: 32.7,
          longitude: -96.8,
          source: "google_geocoding" as const,
          cached: false,
        })),
        now: () => new Date("2026-05-05T12:00:00.000Z"),
      }
    );

    expect(result.addressSource).toBe("live_gps");
    expect(result.address).toBe("200 Live Oak St, Dallas, TX 75202, USA");
  });

  it("falls back to the deal property address without geocoding when coordinates are absent", async () => {
    const reverseGeocode = vi.fn();
    const result = await resolvePhotoAddressMetadata(
      tenantDbWithDealAddress({
        propertyAddress: "300 Deal Rd",
        propertyCity: "Dallas",
        propertyState: "TX",
        propertyZip: "75203",
      }),
      { dealId: "deal-1" },
      {},
      { reverseGeocode }
    );

    expect(reverseGeocode).not.toHaveBeenCalled();
    expect(result).toEqual({
      latitude: null,
      longitude: null,
      geoLat: null,
      geoLng: null,
      address: "300 Deal Rd, Dallas, TX 75203",
      addressSource: "deal_fallback",
      geocodedAt: null,
    });
  });

  it("falls back to the deal property address when geocoding cannot produce an address", async () => {
    const result = await resolvePhotoAddressMetadata(
      tenantDbWithDealAddress({
        propertyAddress: "400 Fallback Ave",
        propertyCity: "Fort Worth",
        propertyState: "TX",
        propertyZip: "76102",
      }),
      { dealId: "deal-1" },
      { latitude: 32.1, longitude: -97.1, addressSource: "exif" },
      {
        reverseGeocode: vi.fn(async () => ({
          address: null,
          latitude: 32.1,
          longitude: -97.1,
          source: "google_geocoding" as const,
          cached: false,
        })),
      }
    );

    expect(result).toMatchObject({
      latitude: "32.1000000",
      longitude: "-97.1000000",
      geoLat: "32.1",
      geoLng: "-97.1",
      address: "400 Fallback Ave, Fort Worth, TX 76102",
      addressSource: "deal_fallback",
      geocodedAt: null,
    });
  });
});
