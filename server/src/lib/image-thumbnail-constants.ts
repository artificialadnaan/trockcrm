/**
 * Thumbnail limits, split out so callers can gate on them WITHOUT importing `image-thumbnail.ts`.
 *
 * That module imports `sharp`, `heic-convert` and the R2 client. A caller that only needs a number
 * should not drag a native image decoder and an S3 client onto its import path, and under vitest's
 * hoisted mocks those dependencies can leave the module's exports uninitialised at the moment another
 * module evaluates a top-level constant derived from them — which is exactly how a ceiling check
 * silently became `> NaN` and stopped rejecting anything. Same reason `files/file-constants.ts` exists
 * separately from `files/service.ts`.
 */

/**
 * Largest source image `generateAndStoreThumbnail` will read (40 MiB).
 *
 * Above this no thumbnail is produced: `getObjectBuffer`'s `maxBytes` caps the fetch, and a
 * caller-supplied buffer throws rather than handing an oversized original to sharp. Any upload path
 * that accepts more than this and then relies on a thumbnail existing has a silent gap — the file list
 * falls back to presigning the full original as its tile.
 */
export const MAX_THUMBNAIL_SOURCE_BYTES = 40 * 1024 * 1024;
