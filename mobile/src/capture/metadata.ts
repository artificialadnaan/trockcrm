import * as Location from "expo-location";

/** Mirrors client-field capture-upload PhotoMetadata. */
export type PhotoMetadata = {
  latitude?: number;
  longitude?: number;
  addressSource?: "exif" | "live_gps";
  takenAt?: string;
};

/**
 * High-accuracy current position for camera captures (and gallery fallback),
 * matching the web getLiveGps (enableHighAccuracy, ~8s). Permission denial or
 * any failure degrades gracefully to a timestamp-only result.
 */
export async function getLiveGps(): Promise<PhotoMetadata> {
  try {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== "granted") return { takenAt: new Date().toISOString() };
    const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
    return {
      latitude: pos.coords.latitude,
      longitude: pos.coords.longitude,
      addressSource: "live_gps",
      takenAt: new Date().toISOString(),
    };
  } catch {
    return { takenAt: new Date().toISOString() };
  }
}

function toSignedCoordinate(value: unknown, ref: unknown, negativeRef: string): number | undefined {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return undefined;
  const refStr = typeof ref === "string" ? ref.toUpperCase() : "";
  return refStr === negativeRef ? -Math.abs(num) : Math.abs(num);
}

function parseExifDate(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  // EXIF DateTimeOriginal: "YYYY:MM:DD HH:MM:SS"
  const m = value.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) {
    const direct = new Date(value);
    return Number.isNaN(direct.getTime()) ? undefined : direct.toISOString();
  }
  const [, y, mo, d, h, mi, s] = m;
  const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * Best-effort GPS + timestamp from an expo-image-picker asset's `exif` payload
 * (gallery imports). Handles both the flat (GPSLatitude/GPSLatitudeRef) and the
 * nested ({GPS}.Latitude) shapes iOS/Android can return. Mirrors the web
 * exifr-based extraction; missing GPS yields an undefined addressSource so the
 * caller can fall back to live GPS.
 */
export function extractExifMetadata(exif: Record<string, unknown> | null | undefined): PhotoMetadata {
  if (!exif) return {};
  const nestedGps = (exif["{GPS}"] ?? exif.GPS) as Record<string, unknown> | undefined;

  const latitude =
    toSignedCoordinate(exif.GPSLatitude, exif.GPSLatitudeRef, "S") ??
    toSignedCoordinate(nestedGps?.Latitude, nestedGps?.LatitudeRef, "S");
  const longitude =
    toSignedCoordinate(exif.GPSLongitude, exif.GPSLongitudeRef, "W") ??
    toSignedCoordinate(nestedGps?.Longitude, nestedGps?.LongitudeRef, "W");

  const takenAt = parseExifDate(exif.DateTimeOriginal ?? exif.DateTime);
  const hasCoords = latitude !== undefined && longitude !== undefined;
  return {
    latitude: hasCoords ? latitude : undefined,
    longitude: hasCoords ? longitude : undefined,
    addressSource: hasCoords ? "exif" : undefined,
    takenAt,
  };
}
