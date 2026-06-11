import * as Location from "expo-location";

/** Mirrors client-field capture-upload PhotoMetadata. */
export type PhotoMetadata = {
  latitude?: number;
  longitude?: number;
  addressSource?: "exif" | "live_gps";
  takenAt?: string;
};

const GPS_TIMEOUT_MS = 8000;

/**
 * High-accuracy current position for camera captures (and gallery fallback),
 * matching the web getLiveGps (~8s budget). A fresh fix is RACED against an 8s
 * timeout so weak indoor GPS can't block capture; on timeout we fall back to the
 * last known position, then to a timestamp-only result. Permission denial / any
 * failure also degrades to timestamp-only.
 */
export async function getLiveGps(): Promise<PhotoMetadata> {
  const takenAt = new Date().toISOString();
  try {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== "granted") return { takenAt };
    const fresh = await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), GPS_TIMEOUT_MS)),
    ]);
    const coords = fresh?.coords ?? (await Location.getLastKnownPositionAsync())?.coords ?? null;
    if (!coords) return { takenAt };
    return { latitude: coords.latitude, longitude: coords.longitude, addressSource: "live_gps", takenAt };
  } catch {
    return { takenAt };
  }
}

// An EXIF value can be a plain number (iOS decimal degrees), a [num, den]
// rational, or a degrees/minutes/seconds array of numbers/rationals.
function asNumber(x: unknown): number {
  if (Array.isArray(x) && x.length === 2 && typeof x[0] !== "object" && typeof x[1] !== "object") {
    const n = Number(x[0]);
    const d = Number(x[1]);
    return d !== 0 ? n / d : NaN;
  }
  return Number(x);
}

function toDecimalDegrees(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? Math.abs(value) : undefined;
  if (Array.isArray(value) && value.length >= 1) {
    // DMS: [degrees, minutes, seconds] (each a number or [num, den] rational).
    const [d = 0, m = 0, s = 0] = value.map(asNumber);
    if (![d, m, s].every(Number.isFinite)) return undefined;
    return Math.abs(d) + Math.abs(m) / 60 + Math.abs(s) / 3600;
  }
  const n = Number(value);
  return Number.isFinite(n) ? Math.abs(n) : undefined;
}

function toSignedCoordinate(value: unknown, ref: unknown, negativeRef: string): number | undefined {
  const magnitude = toDecimalDegrees(value);
  if (magnitude === undefined) return undefined;
  const refStr = typeof ref === "string" ? ref.toUpperCase() : "";
  return refStr === negativeRef ? -magnitude : magnitude;
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
