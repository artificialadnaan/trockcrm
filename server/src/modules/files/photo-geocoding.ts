import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { deals } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import { AppError } from "../../middleware/error-handler.js";
import { reverseGeocode, type ReverseGeocodeResult } from "../../lib/geocoding.js";

export type PhotoAddressSource = "exif" | "live_gps" | "deal_fallback";
export type PhotoAddressTenantDb = NodePgDatabase<typeof schema>;

export interface PhotoAddressInput {
  latitude?: number;
  longitude?: number;
  addressSource?: "exif" | "live_gps";
}

export interface PhotoAddressMetadata {
  latitude: string | null;
  longitude: string | null;
  geoLat: string | null;
  geoLng: string | null;
  address: string | null;
  addressSource: PhotoAddressSource | null;
  geocodedAt: Date | null;
}

interface PendingPhotoAssociation {
  dealId?: string;
}

interface ResolvePhotoAddressDeps {
  reverseGeocode?: (latitude: number, longitude: number) => Promise<ReverseGeocodeResult>;
  now?: () => Date;
}

function hasCoordinatePair(input: PhotoAddressInput): input is PhotoAddressInput & { latitude: number; longitude: number } {
  return input.latitude !== undefined && input.longitude !== undefined;
}

function validateCoordinatePair(input: PhotoAddressInput): void {
  if ((input.latitude === undefined) !== (input.longitude === undefined)) {
    throw new AppError(400, "latitude and longitude must be provided together.");
  }
  if (input.latitude !== undefined && (!Number.isFinite(input.latitude) || input.latitude < -90 || input.latitude > 90)) {
    throw new AppError(400, "latitude must be between -90 and 90.");
  }
  if (input.longitude !== undefined && (!Number.isFinite(input.longitude) || input.longitude < -180 || input.longitude > 180)) {
    throw new AppError(400, "longitude must be between -180 and 180.");
  }
}

function decimalString(value: number, scale: number): string {
  return value.toFixed(scale);
}

function formatDealAddress(row: {
  propertyAddress: string | null;
  propertyCity: string | null;
  propertyState: string | null;
  propertyZip: string | null;
} | null): string | null {
  if (!row?.propertyAddress) return null;

  const cityStateZip = [
    [row.propertyCity, row.propertyState].filter(Boolean).join(", "),
    row.propertyZip,
  ].filter(Boolean).join(" ");
  return [row.propertyAddress, cityStateZip].filter(Boolean).join(", ");
}

async function getDealFallbackAddress(tenantDb: PhotoAddressTenantDb, dealId?: string): Promise<string | null> {
  if (!dealId) return null;

  const [deal] = await tenantDb
    .select({
      propertyAddress: deals.propertyAddress,
      propertyCity: deals.propertyCity,
      propertyState: deals.propertyState,
      propertyZip: deals.propertyZip,
    })
    .from(deals)
    .where(eq(deals.id, dealId))
    .limit(1);

  return formatDealAddress(deal ?? null);
}

export async function resolvePhotoAddressMetadata(
  tenantDb: PhotoAddressTenantDb,
  pending: PendingPhotoAssociation,
  input: PhotoAddressInput,
  deps: ResolvePhotoAddressDeps = {}
): Promise<PhotoAddressMetadata> {
  validateCoordinatePair(input);

  if (!hasCoordinatePair(input)) {
    const fallbackAddress = await getDealFallbackAddress(tenantDb, pending.dealId);
    return {
      latitude: null,
      longitude: null,
      geoLat: null,
      geoLng: null,
      address: fallbackAddress,
      addressSource: fallbackAddress ? "deal_fallback" : null,
      geocodedAt: null,
    };
  }

  const source = input.addressSource ?? "exif";
  const geocode = await (deps.reverseGeocode ?? reverseGeocode)(input.latitude, input.longitude);
  if (geocode.address) {
    return {
      latitude: decimalString(input.latitude, 7),
      longitude: decimalString(input.longitude, 7),
      geoLat: input.latitude.toString(),
      geoLng: input.longitude.toString(),
      address: geocode.address,
      addressSource: source,
      geocodedAt: deps.now?.() ?? new Date(),
    };
  }

  const fallbackAddress = await getDealFallbackAddress(tenantDb, pending.dealId);
  return {
    latitude: decimalString(input.latitude, 7),
    longitude: decimalString(input.longitude, 7),
    geoLat: input.latitude.toString(),
    geoLng: input.longitude.toString(),
    address: fallbackAddress,
    addressSource: fallbackAddress ? "deal_fallback" : source,
    geocodedAt: null,
  };
}
