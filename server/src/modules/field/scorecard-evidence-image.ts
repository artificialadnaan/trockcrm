import { getObjectBuffer, isR2Configured } from "../../lib/r2-client.js";
import { generateEvidenceJpeg } from "../../lib/image-thumbnail.js";
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
 * Formats sharp can actually decode in THIS deployment, so an original is worth fetching to transcode for
 * the PDF: JPEG plus the public transcoder's allowlist (PNG/WebP/GIF/AVIF/TIFF). Deliberately EXCLUDES
 * HEIC/HEIF — the prebuilt sharp has no HEVC decoder (see image-transcode.ts), so a HEIC original can't be
 * rendered. In practice mobile captures are normalized to JPEG before upload (mobile/src/capture/
 * compress.ts), so scorecard evidence reaches R2 as JPEG; this just avoids a doomed fetch+decode for any
 * stray HEIC original (which would degrade to the placeholder either way).
 */
export function isEvidenceTranscodable(mimeType: string | null | undefined): boolean {
  const mime = mimeType?.split(";")[0]?.trim().toLowerCase();
  if (mime === "image/jpeg" || mime === "image/jpg") return true;
  return isTranscodableToJpeg(mimeType);
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
  transcode?: (buffer: Buffer) => Promise<Buffer>;
  /** True when sharp can rasterize this mime type in this deployment (so an original is worth fetching). */
  transcodable?: (mimeType: string | null | undefined) => boolean;
  r2Configured?: () => boolean;
}

/**
 * Resolve a single scorecard evidence photo to a small JPEG buffer for the PDF, or null (→ an explicit
 * "Image unavailable" placeholder). PDF-safe fallback so evidence is never silently dropped:
 *
 *   1. Prefer the ingest-generated thumbnail — already a small stripped JPEG, no decode needed. Fetched
 *      under a tight byte cap.
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
  const r2Configured = deps.r2Configured ?? isR2Configured;
  if (!r2Configured()) return null;
  const fetchObject = deps.fetchObject ?? (async (key, maxBytes) => (await getObjectBuffer(key, { maxBytes })).buffer);
  const transcode = deps.transcode ?? generateEvidenceJpeg;
  const transcodable = deps.transcodable ?? isEvidenceTranscodable;

  // 1. Prefer the ingest thumbnail.
  if (source.thumbnailR2Key) {
    try {
      return await fetchObject(source.thumbnailR2Key, PDF_EVIDENCE_THUMB_MAX_BYTES);
    } catch {
      // Missing / oversized / unreadable thumbnail — fall through to transcoding the original.
    }
  }

  // 2. Transcode the original. Skip formats sharp can't decode here (unknown mime, HEIC/HEIF, PDFs) so we
  //    don't pull bytes we can't render; a genuine decode failure below still degrades to the placeholder.
  if (!transcodable(source.mimeType)) return null;
  try {
    const original = await fetchObject(source.r2Key, PDF_EVIDENCE_ORIGINAL_MAX_BYTES);
    return await transcode(original);
  } catch {
    return null;
  }
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
