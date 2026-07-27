import sharp from "sharp";
import heicConvert from "heic-convert";
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
  // Strip any Content-Type parameters (e.g. "image/jpeg; charset=utf-8" as stored from a raw fetch
  // header) before the equality check, so a parametrized-but-valid image type isn't treated as non-image.
  const m = mimeType.split(";")[0].trim().toLowerCase();
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

/**
 * Resize an image buffer into a small JPEG thumbnail. Throws if sharp can't decode the input.
 *
 * `limitInputPixels` is load-bearing, not defensive style: the public share proxy now calls this to
 * render grid thumbnails on demand for photos with no stored `thumbnail_r2_key`, so this runs on an
 * UNAUTHENTICATED path. Without the cap it would inherit sharp's ~268 MP default — 5x looser than the
 * 50 MP bound the sibling public transcoder (image-transcode.ts) pins for exactly this reason — and a
 * small, highly-compressed 200 MP TIFF inside the byte cap would decode to a raster the full-res path
 * would have refused. 50 MP still covers any real camera photo (a 48 MP phone shot is 8000x6000).
 */
export async function generateThumbnailBuffer(source: Buffer): Promise<Buffer> {
  return sharp(source, { failOn: "none", limitInputPixels: EVIDENCE_DECODE_PIXEL_LIMIT })
    .rotate() // honor EXIF orientation so the thumbnail isn't sideways
    .resize({ width: THUMBNAIL_MAX_EDGE, height: THUMBNAIL_MAX_EDGE, fit: "inside", withoutEnlargement: true })
    // JPEG has no alpha, so transparency would otherwise composite to BLACK. Flatten to white to match
    // transcodeToStrippedJpeg — without this the same transparent PNG renders as a black tile in the
    // share grid and a white one in the lightbox, because those two variants take different encoders.
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .jpeg({ quality: THUMBNAIL_QUALITY, mozjpeg: true })
    .toBuffer();
}

// Cap on the DECODED raster of an original transcoded for the PDF. A small highly-compressed file can
// decode to a gigapixel "pixel bomb"; ~50 MP covers any real camera photo (a 48 MP phone shot is
// 8000x6000) while bounding decode memory when the evidence path runs originals at concurrency. Mirrors
// the public transcoder's guard (image-transcode.ts).
const EVIDENCE_DECODE_PIXEL_LIMIT = 50_000_000;

// `sharp`'s prebuilt binaries omit libheif, but field uploads accept HEIC/HEIF and legacy evidence may not
// have a stored thumbnail. `heic-convert` supplies the narrow WASM compatibility decoder. Validate the
// source dimensions before decode because the converter materializes a full RGBA raster before resize.
const HEIC_DECODE_PIXEL_LIMIT = EVIDENCE_DECODE_PIXEL_LIMIT;
// `heic-convert` expands the complete source into an RGBA raster in the JS/WASM heap before it can be
// resized. A 48–50 MP phone image is roughly 200 MB at that point, so the ordinary four-wide evidence
// pipeline must not run four HEIC decodes at once. This FIFO semaphore is module/process-wide (not merely
// per scorecard), keeping HEIC decode concurrency at one even when several PDF downloads regenerate in
// parallel. JPEG/WebP/etc. remain on the existing four-wide Sharp path.
const HEIC_DECODE_CONCURRENCY = 1;
const HEIC_DECODE_PERMIT = Symbol("scorecard-heic-decode-permit");
let activeHeicDecodes = 0;
const heicDecodeWaiters: Array<() => void> = [];

export async function withHeicDecodePermit<T>(decode: (permit: symbol) => Promise<T>): Promise<T> {
  await new Promise<void>((resolve) => {
    const grant = () => {
      activeHeicDecodes += 1;
      resolve();
    };
    if (activeHeicDecodes < HEIC_DECODE_CONCURRENCY) grant();
    else heicDecodeWaiters.push(grant);
  });

  try {
    return await decode(HEIC_DECODE_PERMIT);
  } finally {
    activeHeicDecodes -= 1;
    // `grant` increments synchronously before resolving the next waiter, reserving the permit so a newly
    // arriving caller cannot slip ahead and temporarily raise active decode count above the limit.
    heicDecodeWaiters.shift()?.();
  }
}

function isHeicOrHeif(mimeType: string | null | undefined): boolean {
  const mime = mimeType?.split(";", 1)[0]?.trim().toLowerCase();
  return mime === "image/heic" || mime === "image/heif";
}

/** Read a bounded HEIF `ispe` image-spatial-extents box before invoking the WASM decoder. */
export function readHeifDimensions(source: Buffer): { width: number; height: number } | null {
  let candidate: { width: number; height: number } | null = null;
  for (let typeOffset = source.indexOf("ispe", 4); typeOffset >= 0; typeOffset = source.indexOf("ispe", typeOffset + 4)) {
    const boxOffset = typeOffset - 4;
    if (boxOffset < 0 || boxOffset + 20 > source.length) continue;
    const boxSize = source.readUInt32BE(boxOffset);
    if (boxSize < 20 || boxOffset + boxSize > source.length) continue;
    const width = source.readUInt32BE(typeOffset + 8);
    const height = source.readUInt32BE(typeOffset + 12);
    if (!width || !height) continue;
    // Fail closed if ANY structurally valid image item is oversized. A HEIF may also carry a small
    // auxiliary thumbnail; accepting either box order would not bound heic-convert's primary-image decode.
    if (width * height > HEIC_DECODE_PIXEL_LIMIT) return null;
    candidate ??= { width, height };
  }
  return candidate;
}

export interface EvidenceJpegOptions {
  /** Opaque permit issued by withHeicDecodePermit when the caller already holds the process-wide gate. */
  heicDecodePermit?: symbol;
}

/**
 * Downscale/transcode a full-size original into a small JPEG for a PDF-embedded evidence tile. Used as
 * the fallback when a photo has no ingest thumbnail, so a large valid original (JPEG/HEIC/HEIF/WebP/PNG/
 * TIFF/AVIF/GIF) is preserved as evidence instead of degrading to "Image unavailable". Reuses the
 * thumbnail dimensions (identical look whether the tile came from a stored thumbnail or a transcode here)
 * and, like the public transcoder, bounds decoded pixels and flattens transparency onto white so a
 * transparent PNG/WebP annotation doesn't render as a black box. Throws if sharp can't decode the input —
 * callers treat a throw as "no image" (placeholder), NEVER as dropping evidence under a byte cap.
 */
export async function generateEvidenceJpeg(
  source: Buffer,
  mimeType?: string | null,
  options: EvidenceJpegOptions = {},
): Promise<Buffer> {
  let rasterSource = source;
  if (isHeicOrHeif(mimeType)) {
    const convert = () => convertHeicToJpeg(source);
    // The scorecard resolver acquires the permit before fetching the original so queued conversions do
    // not retain one 40 MB input buffer apiece. Direct callers remain safe by acquiring it here.
    const converted = options.heicDecodePermit === HEIC_DECODE_PERMIT
      ? await convert()
      : await withHeicDecodePermit(() => convert());
    rasterSource = Buffer.from(converted);
  }
  return sharp(rasterSource, { failOn: "none", limitInputPixels: EVIDENCE_DECODE_PIXEL_LIMIT })
    .rotate() // honor EXIF orientation so the evidence isn't sideways
    .resize({ width: THUMBNAIL_MAX_EDGE, height: THUMBNAIL_MAX_EDGE, fit: "inside", withoutEnlargement: true })
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .jpeg({ quality: THUMBNAIL_QUALITY, mozjpeg: true })
    .toBuffer();
}

async function convertHeicToJpeg(source: Buffer, quality: number = THUMBNAIL_QUALITY / 100): Promise<Uint8Array> {
  if (!readHeifDimensions(source)) {
    throw new Error("HEIC/HEIF image is malformed or exceeds the PDF evidence decode limit");
  }
  return heicConvert({ buffer: source, format: "JPEG", quality });
}

/** Quality for a stored FULL-SIZE JPEG (higher than the thumbnail quality — this is the original a user views). */
const STORABLE_JPEG_QUALITY = 88;
/** Near-lossless intermediate for the HEIC decode, so re-encoding to the stored JPEG isn't stacked on top of
 *  the thumbnail-grade (0.70) compression the evidence path uses. */
const STORABLE_HEIC_DECODE_QUALITY = 0.95;

/**
 * Transcode a HEIC/HEIF original into a FULL-RESOLUTION JPEG for storage — EXIF-rotated and with any
 * transparency flattened onto white, but NOT downscaled (unlike generateEvidenceJpeg, which resizes to a
 * thumbnail). Decoded at near-lossless quality so the stored full-size cover isn't thumbnail-grade. Used so
 * a HEIC cover photo keeps its resolution and renders in every browser. Throws if the input can't be
 * decoded (the caller surfaces that as a 4xx, never a broken stored object).
 */
export async function transcodeHeicToStorableJpeg(source: Buffer): Promise<Buffer> {
  const converted = await withHeicDecodePermit(() => convertHeicToJpeg(source, STORABLE_HEIC_DECODE_QUALITY));
  return sharp(Buffer.from(converted), { failOn: "none", limitInputPixels: EVIDENCE_DECODE_PIXEL_LIMIT })
    .rotate()
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .jpeg({ quality: STORABLE_JPEG_QUALITY, mozjpeg: true })
    .toBuffer();
}

const RENDERABLE_FORMAT_TO_MIME: Record<string, { mime: string; extension: string }> = {
  jpeg: { mime: "image/jpeg", extension: "jpg" },
  png: { mime: "image/png", extension: "png" },
  webp: { mime: "image/webp", extension: "webp" },
  gif: { mime: "image/gif", extension: "gif" },
};

/**
 * Decode `source` and return the canonical MIME + extension derived from the ACTUAL bytes — not the client's
 * Content-Type/filename, which can be spoofed or simply wrong. Throws if the bytes don't decode or aren't a
 * browser-renderable raster we store for a cover photo. This rejects e.g. a TIFF renamed to `.jpg`, which
 * would otherwise be stored and served as image/jpeg and render as a broken <img>; a corrupt body with a
 * valid header is also rejected by the forced pixel decode. HEIC/HEIF are transcoded upstream, not here.
 */
export async function probeStorableImageFormat(source: Buffer): Promise<{ mime: string; extension: string }> {
  const { format } = await sharp(source, { failOn: "error", limitInputPixels: EVIDENCE_DECODE_PIXEL_LIMIT }).metadata();
  const mapped = format ? RENDERABLE_FORMAT_TO_MIME[format] : undefined;
  if (!mapped) {
    throw new Error(`unsupported or undecodable cover image format: ${format ?? "unknown"}`);
  }
  // Force a real pixel decode so a corrupt body behind a valid header is rejected too.
  await sharp(source, { failOn: "error", limitInputPixels: EVIDENCE_DECODE_PIXEL_LIMIT })
    .resize({ width: 32, height: 32, fit: "inside", withoutEnlargement: true })
    .toBuffer();
  return mapped;
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
        } else if (source.byteLength > MAX_SOURCE_BYTES) {
          // A caller-supplied buffer (CompanyCam) bypasses the getObjectBuffer cap — enforce it here so an
          // oversized original isn't handed to sharp to decode. Throwing routes to the best-effort fallback.
          throw new Error(`source buffer ${source.byteLength} exceeds ${MAX_SOURCE_BYTES} bytes`);
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
