import type { PhotoMetadata } from "./metadata";

/**
 * A photo collected in the capture session (from the burst camera or a library
 * import). `caption` is the OPTIONAL per-photo description, set only later in the
 * review tray — capture itself is never blocked by it.
 */
export type SessionPhoto = {
  key: string;
  uri: string;
  width?: number;
  height?: number;
  metadata: PhotoMetadata;
  caption: string;
};

/**
 * Resolve the description a photo uploads with. The per-photo caption wins; the
 * batch caption is the fallback applied to any photo the user didn't caption
 * individually ("individual overrides batch"). Empty on both → null (no caption).
 */
export function effectiveCaption(photoCaption: string, batchCaption: string): string | null {
  const own = photoCaption.trim();
  if (own) return own;
  const batch = batchCaption.trim();
  return batch || null;
}

/**
 * Back-patch a late-arriving session GPS fix onto the photos captured before it
 * resolved (tracked by `keys`). Burst capture never waits on GPS, so the first
 * shots can land before the fix; this geotags them once it arrives, keeping each
 * shot's own takenAt and only adding coordinates. No-op when nothing is pending
 * or the fix has no coordinates.
 */
export function applyGpsToPending(photos: SessionPhoto[], keys: Set<string>, gps: PhotoMetadata): SessionPhoto[] {
  if (keys.size === 0 || gps.latitude === undefined || gps.longitude === undefined) return photos;
  return photos.map((p) =>
    keys.has(p.key)
      ? { ...p, metadata: { ...p.metadata, latitude: gps.latitude, longitude: gps.longitude, addressSource: gps.addressSource } }
      : p,
  );
}
