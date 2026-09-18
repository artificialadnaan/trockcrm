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

/**
 * Coordinates and NOTHING ELSE — deliberately not a PhotoMetadata.
 *
 * getLiveGps bundles a `takenAt`, which is correct at a shutter press (now() IS the capture moment) and
 * wrong for a library import (now() is when the crew tapped Import). The import path used to inherit that
 * field, stamping every photo in a selection with the same import-time timestamp. Giving the import
 * fallback a type that CANNOT carry a time is what stops that from being reintroduced.
 */
export type FallbackCoords = { latitude: number; longitude: number; addressSource: "live_gps" };

/**
 * A coordinate fallback for LIBRARY IMPORTS, for photos whose EXIF recorded no position of their own.
 *
 * Unlike getLiveGps this does NOT race an 8s high-accuracy fix. An imported photo was taken somewhere else
 * at some other time, so a precise fix acquired NOW is no more truthful about where it was taken than the
 * cached one — both are guesses about a location the file never recorded. Spending eight seconds of frozen
 * screen to sharpen a guess is a bad trade, so this reads only the last known position.
 *
 * Null on denial, no cached fix, or any failure — the photo then uploads with no coordinates rather than
 * borrowed ones.
 */
export async function getImportFallbackCoords(): Promise<FallbackCoords | null> {
  try {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== "granted") return null;
    const coords = (await Location.getLastKnownPositionAsync())?.coords;
    if (!coords || !Number.isFinite(coords.latitude) || !Number.isFinite(coords.longitude)) return null;
    return { latitude: coords.latitude, longitude: coords.longitude, addressSource: "live_gps" };
  } catch {
    return null;
  }
}

/**
 * The metadata ONE imported photo should upload with. Pure, so the ladder below is unit-proven without a
 * device.
 *
 * TIME ladder, in descending order of authority — and it deliberately ENDS:
 *   1. the file's own EXIF DateTimeOriginal (the camera's record)
 *   2. the Photos library's creation time for the asset (covers stripped/absent EXIF)
 *   3. nothing. `takenAt` stays undefined, the server stores null, and every consumer falls back to
 *      COALESCE(taken_at, created_at) while the UI says "Same as uploaded".
 *
 * There is no now() rung on purpose. A wrong-but-non-null timestamp is worse than an absent one: it reads
 * as a real capture time everywhere, reorders the CRM photo timeline, and files the photo into the wrong
 * month bucket, with nothing marking it as a guess.
 *
 * POSITION is independent of time: EXIF coordinates win, else the caller's fallback fix is borrowed (an
 * approximation the crew can see and correct), else the photo simply has none.
 */
export function buildImportMetadata(
  exifMeta: PhotoMetadata,
  libraryTakenAt: string | undefined,
  fallbackCoords: FallbackCoords | null,
): PhotoMetadata {
  const takenAt = exifMeta.takenAt ?? libraryTakenAt;
  if (hasPhotoCoords(exifMeta)) return { ...exifMeta, takenAt };
  return fallbackCoords ? { ...fallbackCoords, takenAt } : { takenAt };
}

/** True when a shot carries a usable fix. BOTH coordinates — one without the other is not a location. */
export function hasPhotoCoords(metadata: PhotoMetadata): boolean {
  return metadata.latitude !== undefined && metadata.longitude !== undefined;
}

/**
 * Merge an already-resolved live GPS fix into a shot's EXIF, but ONLY its location.
 *
 * Pure, so a batch import can fetch live GPS once and reuse it across every coordless asset — the
 * per-asset `getLiveGps` it replaces serialised up to 8s per photo, which is minutes on a large indoor
 * import.
 *
 * `takenAt` is deliberately NOT taken from `live`. `getLiveGps` always stamps `takenAt: now`, so a plain
 * spread silently replaces a photo's real capture time with the moment it was imported. That is wrong as
 * provenance, and it also breaks the weekly report's picker: candidates are filtered on
 * `COALESCE(taken_at, created_at)` against the 14 days ending on `week_of`, so a photo restamped to today
 * falls outside the window of a report filed late and disappears from its own selection on reload.
 * Location-stripped images — anything shared through a messaging app — are the common case, not the edge.
 */
export function mergeLiveGpsIntoExif(
  exif: PhotoMetadata,
  live: PhotoMetadata | null,
): PhotoMetadata {
  if (hasPhotoCoords(exif)) return exif;
  if (live && hasPhotoCoords(live)) {
    return {
      ...exif,
      latitude: live.latitude,
      longitude: live.longitude,
      addressSource: live.addressSource ?? exif.addressSource,
    };
  }
  return exif;
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
  if (Array.isArray(value)) {
    // A bare 2-element array is an EXIF rational [numerator, denominator]
    // (e.g. [327, 10] = 32.7°), NOT a degrees/minutes tuple — standard GPS DMS
    // always has three components (deg, min, sec).
    if (value.length === 2) {
      const n = asNumber(value);
      return Number.isFinite(n) ? Math.abs(n) : undefined;
    }
    if (value.length >= 1) {
      // DMS: [degrees, minutes, seconds] (each a number or [num, den] rational).
      const [d = 0, m = 0, s = 0] = value.map(asNumber);
      if (![d, m, s].every(Number.isFinite)) return undefined;
      return Math.abs(d) + Math.abs(m) / 60 + Math.abs(s) / 3600;
    }
    return undefined;
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
