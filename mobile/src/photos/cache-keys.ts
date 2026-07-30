/**
 * Image-cache keys for a photo's two renditions.
 *
 * expo-image keys its cache on the source `uri` unless given an explicit `cacheKey`, and our URLs are
 * presigned — the signature changes on every list refetch, so a URL-keyed entry misses every single time
 * and re-downloads bytes already on disk. Keying on the immutable photo id fixes that.
 *
 * These live together, and are the ONLY place the suffixes are written, because the grid and the viewer
 * have to agree: the viewer shows the grid's thumbnail as its placeholder while the full-size original
 * loads, and that only works if it looks the entry up under the key the grid stored it as. Derive the key
 * independently in two files and they drift silently — the placeholder just stops appearing, which shows
 * up as the blank pane the placeholder exists to prevent.
 */

/** The full-resolution original, as shown in the photo viewer. */
export function photoCacheKey(photoId: string): string {
  return photoId;
}

/** The small grid thumbnail — a DIFFERENT entry from the original, hence the suffix. */
export function thumbnailCacheKey(photoId: string): string {
  return `${photoId}#thumb`;
}
