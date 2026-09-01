import * as MediaLibrary from "expo-media-library";

/**
 * The Photos library's own record of when a picked asset was created, as an ISO string.
 *
 * This is rung 2 of the import timestamp ladder, below the file's own EXIF DateTimeOriginal. A screenshot,
 * an AirDropped photo, or anything whose EXIF was stripped in transit carries no capture time in its bytes,
 * but the Photos database still knows when the asset arrived. `assetId` already rides on every picker
 * result, so this costs nothing on the common path where the camera did write a DateTimeOriginal (the
 * caller skips it entirely then).
 *
 * `shouldDownloadFromNetwork: false` is LOAD-BEARING, not a tuning knob. It defaults to TRUE
 * (MediaLibrary.ts:696), and on iOS the true path requests content-editing input — which pulls the full
 * original down from iCloud before it will hand back a creation time. That would reintroduce, inside a
 * best-effort metadata lookup, exactly the unbounded network wait this change exists to remove: up to a
 * hundred originals re-fetched while the crew stares at a spinner. Offline, an asset whose metadata is not
 * resident simply resolves undefined and the ladder falls through to leaving takenAt unset.
 *
 * BEST-EFFORT: resolves undefined for a missing id, a limited photo-library grant (which can leave
 * `assetId` null), or any failure. The caller MUST treat undefined as "unknown" and leave takenAt unset —
 * never as "now". An invented timestamp is worse than an absent one: `taken_at` is non-null so nothing
 * downstream flags it, the CRM photo timeline silently reorders around it, and the UI prints it with the
 * same confidence as a real capture time. A null instead renders honestly as "Same as uploaded".
 */
export async function getLibraryCreationTime(assetId: string | null | undefined): Promise<string | undefined> {
  if (!assetId) return undefined;
  try {
    const info = await MediaLibrary.getAssetInfoAsync(assetId, { shouldDownloadFromNetwork: false });
    const ms = info?.creationTime;
    // `creationTime` is epoch milliseconds. Reject the non-finite and non-positive cases rather than letting
    // them become 1970 — a plausible-looking wrong date is precisely what this ladder exists to prevent.
    if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return undefined;
    const date = new Date(ms);
    // An out-of-range epoch survives isFinite but yields an Invalid Date, whose toISOString THROWS.
    if (Number.isNaN(date.getTime())) return undefined;
    return date.toISOString();
  } catch {
    // Never surfaced to the crew: a missing creation time is a normal outcome (limited access, an asset the
    // picker resolved out-of-process), not an error, and the import proceeds with takenAt unset.
    return undefined;
  }
}
