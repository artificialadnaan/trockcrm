import sharp from "sharp";

// Raster formats sharp's PREBUILT binaries can decode (and therefore we can re-encode to a stripped
// JPEG). Deliberately EXCLUDES HEIC/HEIF — their decoder (libheif) isn't in the prebuilt build — so
// those stay non-servable on the public surface (placeholder, never the raw original). JPEG is handled
// by the faster stream-strip path, not here.
const TRANSCODABLE_MIME = new Set(["image/png", "image/webp", "image/gif", "image/avif", "image/tiff"]);
const TRANSCODABLE_EXT = new Set(["png", "webp", "gif", "avif", "tif", "tiff"]);

/**
 * True when a non-JPEG R2 original can be re-encoded to a stripped JPEG by the proxy. Mirrors
 * isStrippableJpeg's mime-first-then-extension precedence.
 */
export function isTranscodableToJpeg(mimeType?: string | null, fileExtension?: string | null): boolean {
  const mime = mimeType?.trim().toLowerCase();
  if (mime) return TRANSCODABLE_MIME.has(mime);
  const ext = fileExtension?.trim().toLowerCase().replace(/^\.?/, "");
  return ext ? TRANSCODABLE_EXT.has(ext) : false;
}

/**
 * Re-encode a non-JPEG raster image (PNG/WebP/GIF/AVIF/TIFF) to a JPEG with ALL metadata dropped, for
 * the PUBLIC photo proxy. The public surface only ever serves JPEG so that embedded EXIF/GPS can't
 * leak; a non-JPEG R2 original used to be dropped (null imageUrl / 404). This converts it instead so
 * the share page can display it — without ever streaming the raw original.
 *
 * Exposure-preserving by construction:
 *   - sharp strips EXIF/XMP/IPTC/GPS by default — we deliberately do NOT call `.withMetadata()`.
 *   - `.rotate()` (no args) bakes in the source's EXIF orientation BEFORE that metadata is discarded,
 *     so the JPEG isn't sideways but carries no orientation/GPS tag.
 *
 * Throws if the bytes can't be decoded — notably HEIC/HEIF, whose decoder (libheif) is NOT in sharp's
 * prebuilt binaries. Callers MUST treat a throw as "do not serve" (404), NEVER as "serve the raw
 * original" — that is the whole point of the JPEG-only public surface.
 */
export async function transcodeToStrippedJpeg(input: Buffer): Promise<Buffer> {
  return sharp(input, { failOn: "none" })
    .rotate()
    .jpeg({ quality: 82 })
    .toBuffer();
}
