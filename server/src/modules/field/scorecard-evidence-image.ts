import {
  getObjectBuffer,
  isR2Configured,
  isR2ObjectNotFoundError,
  ObjectTooLargeError,
} from "../../lib/r2-client.js";
import {
  generateEvidenceJpeg,
  withHeicDecodePermit,
  type EvidenceJpegOptions,
} from "../../lib/image-thumbnail.js";
import { isTranscodableToJpeg } from "../public-photo-tokens/image-transcode.js";

// Evidence-image resolution for the scorecard PDF, kept in its own light module (no drizzle/pdfkit/service
// graph) so its unit tests transform quickly and don't time out in the loaded CI runner.

// Ingest thumbnails are already small stripped JPEGs (~30–80 KB); keep a tight cap on that fetch.
const PDF_EVIDENCE_THUMB_MAX_BYTES = 750_000;
// When no thumbnail exists we fetch the ORIGINAL and downscale it. Allow a generous cap here (matching the
// ingest thumbnailer's source ceiling) so a large valid camera original is preserved as evidence rather
// than dropped — decode memory is bounded by generateEvidenceJpeg's pixel limit + the batch concurrency.
const PDF_EVIDENCE_ORIGINAL_MAX_BYTES = 40 * 1024 * 1024;

/**
 * Formats with a PDF-safe conversion path in this deployment: JPEG plus the public transcoder's allowlist
 * (PNG/WebP/GIF/AVIF/TIFF) and HEIC/HEIF through the bounded compatibility decoder in image-thumbnail.ts.
 */
export function isEvidenceTranscodable(mimeType: string | null | undefined): boolean {
  const mime = mimeType?.split(";")[0]?.trim().toLowerCase();
  if (mime === "image/jpeg" || mime === "image/jpg" || mime === "image/heic" || mime === "image/heif") return true;
  return isTranscodableToJpeg(mimeType);
}

function requiresHeicDecodePermit(mimeType: string | null | undefined): boolean {
  const mime = mimeType?.split(";")[0]?.trim().toLowerCase();
  return mime === "image/heic" || mime === "image/heif";
}

export interface ScorecardEvidenceSource {
  r2Key: string;
  thumbnailR2Key: string | null;
  mimeType: string | null;
}

export interface ScorecardEvidenceImageDeps {
  /** Fetch an R2 object's bytes, throwing if it exceeds maxBytes (ObjectTooLargeError). */
  fetchObject?: (key: string, maxBytes: number) => Promise<Buffer>;
  /** Downscale/transcode a full-size original into a small JPEG. Throws if it can't be decoded. */
  transcode?: (
    buffer: Buffer,
    mimeType?: string | null,
    options?: EvidenceJpegOptions,
  ) => Promise<Buffer>;
  /** True when sharp can rasterize this mime type in this deployment (so an original is worth fetching). */
  transcodable?: (mimeType: string | null | undefined) => boolean;
  r2Configured?: () => boolean;
}

export type ScorecardEvidenceFailureReason =
  | "storage_unavailable"
  | "source_missing"
  | "source_too_large"
  | "unsupported_format"
  | "invalid_image";

export type ScorecardEvidenceImageResolution =
  | { image: Buffer; failure: null }
  | { image: null; failure: { reason: ScorecardEvidenceFailureReason; retryable: boolean } };

/**
 * Resolve a single scorecard evidence photo to a small JPEG buffer for the PDF, or null (→ an explicit
 * "Image unavailable" placeholder). PDF-safe fallback so evidence is never silently dropped:
 *
 *   1. Prefer the ingest-generated thumbnail. Fetch it under a tight byte cap, then decode/re-emit it as
 *      JPEG so corrupt or mislabeled non-empty bytes can never become a permanently current PDF placeholder.
 *   2. If there's no thumbnail (or it's unreadable), fetch the ORIGINAL under a generous cap and downscale
 *      it to a small JPEG. This is the reviewer's core fix: previously the original was fetched under the
 *      thumbnail-sized 750 KB cap, so a large valid JPEG/WebP/PNG original threw ObjectTooLarge and
 *      rendered as "Image unavailable".
 *
 * Deps are injected so the decision tree is unit-testable without R2/sharp.
 */
export async function loadScorecardEvidenceImage(
  source: ScorecardEvidenceSource,
  deps: ScorecardEvidenceImageDeps = {},
): Promise<Buffer | null> {
  return (await resolveScorecardEvidenceImage(source, deps)).image;
}

/**
 * Detailed resolver used by artifact finalization. Transient R2/configuration errors remain retryable and
 * must not stamp a current PDF; irrecoverable source problems render an explicit placeholder so one bad
 * legacy object cannot block the rest of the report forever.
 */
export async function resolveScorecardEvidenceImage(
  source: ScorecardEvidenceSource,
  deps: ScorecardEvidenceImageDeps = {},
): Promise<ScorecardEvidenceImageResolution> {
  const r2Configured = deps.r2Configured ?? isR2Configured;
  if (!r2Configured()) {
    return { image: null, failure: { reason: "storage_unavailable", retryable: true } };
  }
  const fetchObject = deps.fetchObject ?? (async (key, maxBytes) => (await getObjectBuffer(key, { maxBytes })).buffer);
  const transcode = deps.transcode ?? generateEvidenceJpeg;
  const transcodable = deps.transcodable ?? isEvidenceTranscodable;

  // 1. Prefer the ingest thumbnail.
  if (source.thumbnailR2Key) {
    try {
      const thumbnail = await fetchObject(source.thumbnailR2Key, PDF_EVIDENCE_THUMB_MAX_BYTES);
      return { image: await transcode(thumbnail), failure: null };
    } catch {
      // Missing / oversized / undecodable thumbnail — fall through to transcoding the original.
    }
  }

  // 2. Transcode the original. Unsupported/document formats are a permanent source limitation, not an R2
  // outage: include a labeled placeholder but allow the rest of the scorecard PDF to export.
  if (!transcodable(source.mimeType)) {
    return { image: null, failure: { reason: "unsupported_format", retryable: false } };
  }
  const resolveOriginal = async (heicDecodePermit?: symbol): Promise<ScorecardEvidenceImageResolution> => {
    let original: Buffer;
    try {
      original = await fetchObject(source.r2Key, PDF_EVIDENCE_ORIGINAL_MAX_BYTES);
    } catch (error) {
      if (error instanceof ObjectTooLargeError) {
        return { image: null, failure: { reason: "source_too_large", retryable: false } };
      }
      if (isR2ObjectNotFoundError(error)) {
        return { image: null, failure: { reason: "source_missing", retryable: false } };
      }
      return { image: null, failure: { reason: "storage_unavailable", retryable: true } };
    }
    try {
      const image = heicDecodePermit === undefined
        ? await transcode(original, source.mimeType)
        : await transcode(original, source.mimeType, { heicDecodePermit });
      return { image, failure: null };
    } catch {
      return { image: null, failure: { reason: "invalid_image", retryable: false } };
    }
  };

  // Acquire before R2 GET, not merely before WASM decode. This bounds retained original buffers across
  // concurrent scorecard renders as well as the ~200 MB decoded RGBA raster itself.
  return requiresHeicDecodePermit(source.mimeType)
    ? withHeicDecodePermit((permit) => resolveOriginal(permit))
    : resolveOriginal();
}

/**
 * Prioritize + cap evidence photos BEFORE downloading their bytes, so the artifact job never fetches or
 * transcodes tiles the renderer would only discard. Critical-deficiency evidence (sectionKey ===
 * "critical_deficiency") is kept first — matching the PDF's deficiency-first ordering — so it's never
 * starved by routine section photos. Leadership category evidence is kept before Project Summary photos.
 * Within each tier the caller's deterministic order is preserved.
 * Returns the ≤max rows to load plus how many were dropped (surfaced as the PDF's "available in the CRM"
 * note).
 */
export function prioritizeAndCapEvidencePhotos<T extends { sectionKey: string }>(
  rows: T[],
  max: number,
  kind?: "leadership",
): { keep: T[]; omitted: number } {
  const limit = Math.max(0, max);
  if (rows.length <= limit) return { keep: rows, omitted: 0 };
  if (kind === "leadership") {
    const categoryEvidence = rows.filter((r) => r.sectionKey !== "project_summary");
    const summaryEvidence = rows.filter((r) => r.sectionKey === "project_summary");
    return { keep: [...categoryEvidence, ...summaryEvidence].slice(0, limit), omitted: rows.length - limit };
  }
  const deficiency = rows.filter((r) => r.sectionKey === "critical_deficiency");
  const sections = rows.filter((r) => r.sectionKey !== "critical_deficiency");
  const keep = [...deficiency, ...sections].slice(0, limit);
  return { keep, omitted: rows.length - keep.length };
}
