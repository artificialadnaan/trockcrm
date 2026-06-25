import sharp from "sharp";
import { getObjectBuffer, putObject, isR2Configured } from "./r2-client.js";

/**
 * Server-side photo thumbnails. The grid loads a small JPEG generated here; the lightbox keeps the
 * full-size original at the file's `r2Key`. Generation is deliberately BEST-EFFORT: a failure (sharp
 * can't decode, R2 hiccup, not configured) returns null and the upload still succeeds — the display
 * layer falls back to the original key, so the only cost of a miss is a heavier grid tile, never a
 * broken upload.
 */

// Longest edge of the generated thumbnail. ~600px covers a retina grid tile (rendered ~150-300px)
// while staying tiny (~30-60KB at q70), so a 400-photo timeline loads quickly.
const THUMBNAIL_MAX_EDGE = 600;
const THUMBNAIL_QUALITY = 70;
// Don't pull originals larger than this into memory just to thumbnail them (defends against a rogue
// huge upload). A miss here is non-fatal — the grid falls back to the original.
const MAX_SOURCE_BYTES = 40 * 1024 * 1024;
// Hard ceiling on how long thumbnailing may add to the caller. confirmUpload() awaits this on the
// request path, so a slow R2 fetch/decode/resize must not stall an upload — past this we give up and
// the grid falls back to the original. (The in-flight work may still finish and write the thumb object;
// that's a harmless orphan a future backfill can re-link via the deterministic key.)
const THUMBNAIL_TIMEOUT_MS = 2500;

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    work.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/** True for mime types sharp can rasterize into a thumbnail. Excludes PDFs/docs and SVG (untrusted). */
export function isThumbnailableImage(mimeType: string | null | undefined): boolean {
  if (!mimeType) return false;
  const m = mimeType.toLowerCase();
  return (
    m === "image/jpeg" ||
    m === "image/jpg" ||
    m === "image/png" ||
    m === "image/webp" ||
    m === "image/heic" ||
    m === "image/heif" ||
    m === "image/tiff" ||
    m === "image/gif"
  );
}

/**
 * Derive the thumbnail's R2 key from the original's: a sibling `thumbs/` folder, always `.jpg`
 * (sharp emits JPEG regardless of source format). Deterministic so a future backfill can recompute it.
 *   office_x/deals/D-1/photos/foo.heic -> office_x/deals/D-1/photos/thumbs/foo.jpg
 */
export function deriveThumbnailKey(r2Key: string): string {
  const slash = r2Key.lastIndexOf("/");
  const dir = slash >= 0 ? r2Key.slice(0, slash) : "";
  const file = slash >= 0 ? r2Key.slice(slash + 1) : r2Key;
  const dot = file.lastIndexOf(".");
  const stem = dot > 0 ? file.slice(0, dot) : file;
  return `${dir ? `${dir}/` : ""}thumbs/${stem}.jpg`;
}

/** Resize an image buffer into a small JPEG thumbnail. Throws if sharp can't decode the input. */
export async function generateThumbnailBuffer(source: Buffer): Promise<Buffer> {
  return sharp(source, { failOn: "none" })
    .rotate() // honor EXIF orientation so the thumbnail isn't sideways
    .resize({ width: THUMBNAIL_MAX_EDGE, height: THUMBNAIL_MAX_EDGE, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: THUMBNAIL_QUALITY, mozjpeg: true })
    .toBuffer();
}

/**
 * Generate a thumbnail for an already-stored image and persist it to R2, returning its key (or null on
 * any miss — never throws). Pass `sourceBuffer` when the caller already holds the original bytes
 * (CompanyCam sync) to skip the R2 round-trip; otherwise the original is fetched from `r2Key`.
 */
export async function generateAndStoreThumbnail(
  r2Key: string,
  mimeType: string | null | undefined,
  sourceBuffer?: Buffer,
): Promise<string | null> {
  if (!isThumbnailableImage(mimeType)) return null;
  if (!isR2Configured()) return null;
  try {
    // Best-effort AND time-bounded: never block an upload on a thumbnail, even on a slow fetch/decode.
    return await withTimeout(
      (async () => {
        let source = sourceBuffer;
        if (!source) {
          const got = await getObjectBuffer(r2Key, { maxBytes: MAX_SOURCE_BYTES });
          source = got.buffer;
        }
        const thumb = await generateThumbnailBuffer(source);
        const thumbnailKey = deriveThumbnailKey(r2Key);
        await putObject(thumbnailKey, thumb, "image/jpeg");
        return thumbnailKey;
      })(),
      THUMBNAIL_TIMEOUT_MS,
    );
  } catch (err) {
    // Log and fall back to the original (heavier grid tile, never a broken upload).
    console.error(`[thumbnail] skipped for ${r2Key}:`, err);
    return null;
  }
}
