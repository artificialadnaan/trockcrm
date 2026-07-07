import type { PhotoMetadata } from "./metadata";
// Type-only import (erased at runtime — no cycle: upload.ts does not import this module).
import type { CaptureTargetRef, CaptureUploadInput } from "./upload";

/**
 * A photo collected in the capture session (from the burst camera or a library
 * import). `caption` is the OPTIONAL per-photo description, set only later in the
 * review tray — capture itself is never blocked by it. Per-photo ONLY: a blank
 * caption means NO description; a note is never copied from one photo onto another.
 */
export type SessionPhoto = {
  key: string;
  uri: string;
  width?: number;
  height?: number;
  metadata: PhotoMetadata;
  caption: string;
  // Stable idempotency key, assigned at capture time and carried through enqueue → confirm-upload, so a
  // resumed/background re-upload of this exact shot can never create a duplicate server-side.
  clientUploadId: string;
  // Camera-session token the shot was captured in (undefined for library imports).
  // GPS reconciliation is scoped to this so a later session's fix can't geotag an
  // earlier session's shot with the wrong location.
  cameraSession?: number;
};

/**
 * Resolve the description a photo uploads with. PER-PHOTO ONLY: a photo carries only
 * its own optional caption, and a blank caption means NO description — there is no
 * shared/batch fallback, so a note is never copied from one photo onto another.
 */
export function effectiveCaption(photoCaption: string): string | null {
  return photoCaption.trim() || null;
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

/**
 * The metadata a photo should upload with, reconciling a resolved session GPS into
 * a still-ungeotagged shot AT UPLOAD time. Scoped to the camera session: the fix is
 * only applied to a shot captured in `gpsSession`, so an earlier session's shot is
 * never geotagged with a later session's coordinates (it stays as-is). Already-
 * geotagged shots, imports (no cameraSession), and a coordinate-less fix are no-ops.
 */
export function reconcileUploadGps(
  photo: SessionPhoto,
  sessionGps: PhotoMetadata | null,
  gpsSession: number | null,
): PhotoMetadata {
  const m = photo.metadata;
  if (m.latitude !== undefined && m.longitude !== undefined) return m;
  if (!sessionGps || sessionGps.latitude === undefined || sessionGps.longitude === undefined) return m;
  if (photo.cameraSession === undefined || photo.cameraSession !== gpsSession) return m;
  return { ...m, latitude: sessionGps.latitude, longitude: sessionGps.longitude, addressSource: sessionGps.addressSource };
}

/**
 * Build the exact upload payload for ONE photo — the single mapping `upload()` uses
 * for every shot. Keeps each photo's OWN caption (per-photo only, blank → no
 * description) and its OWN reconciled metadata bound to that photo, so the note a crew
 * set for a shot always rides with THAT shot and never bleeds onto another.
 * Pure (no fetcher/network) so this correctness is unit-tested without a device.
 */
export function buildCaptureUploadInput(
  photo: SessionPhoto,
  ctx: {
    target: CaptureTargetRef;
    category: string | null;
    tags: string[];
    sessionGps: PhotoMetadata | null;
    gpsSession: number | null;
  },
): CaptureUploadInput {
  return {
    uri: photo.uri,
    width: photo.width,
    height: photo.height,
    target: ctx.target,
    category: ctx.category,
    caption: effectiveCaption(photo.caption),
    tags: ctx.tags,
    metadata: reconcileUploadGps(photo, ctx.sessionGps, ctx.gpsSession),
    clientUploadId: photo.clientUploadId,
  };
}

/**
 * Review-tray caption reducers. Each edits exactly ONE photo (matched by key) and returns a new array;
 * every other photo is untouched, so a caption can never bleed across the batch (per-photo only). Extracted
 * from the capture screen so the independence is unit-proven without a device.
 */
export function setPhotoCaption(photos: SessionPhoto[], key: string, text: string): SessionPhoto[] {
  return photos.map((p) => (p.key === key ? { ...p, caption: text } : p));
}

/** Append (used by voice dictation) so rapid transcripts concatenate on the SAME photo instead of clobbering. */
export function appendPhotoCaption(photos: SessionPhoto[], key: string, text: string): SessionPhoto[] {
  return photos.map((p) => (p.key === key ? { ...p, caption: p.caption ? `${p.caption} ${text}` : text } : p));
}

/** Drop a staged photo from the review set (by key). */
export function removePhoto(photos: SessionPhoto[], key: string): SessionPhoto[] {
  return photos.filter((p) => p.key !== key);
}

/**
 * Partition the staged review photos on Done by whether each was already DURABLY ENQUEUED at review-open.
 * Photos in `durableIds` are in the upload queue already, so they only need a CAPTION PATCH (never a
 * re-enqueue — that would upload a duplicate). Photos NOT in the set failed to enqueue at review-open
 * (storage full, or a signed-out ownerKey) and must be enqueued NOW as a fallback (caption and all) so they
 * are never lost. Splitting the two lists is the whole no-double-enqueue decision — kept pure so the
 * crash-safety contract is unit-proven independent of the capture component. Order is preserved within each
 * partition.
 */
export function planReviewFinish(
  photos: SessionPhoto[],
  durableIds: ReadonlySet<string>,
): { toPatch: SessionPhoto[]; toEnqueue: SessionPhoto[] } {
  const toPatch: SessionPhoto[] = [];
  const toEnqueue: SessionPhoto[] = [];
  for (const p of photos) {
    if (durableIds.has(p.clientUploadId)) toPatch.push(p);
    else toEnqueue.push(p);
  }
  return { toPatch, toEnqueue };
}
