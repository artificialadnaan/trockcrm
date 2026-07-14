import { createHash } from "node:crypto";

/**
 * Revision of the scorecard PDF renderer currently deployed by the server.
 *
 * Version 1 is the legacy/unversioned artifact. Version 2 embeds linked evidence photos. Keeping this
 * independent of the scorecard form version lets artifact upgrades occur without changing scoring data.
 */
export const CURRENT_SCORECARD_PDF_RENDER_VERSION = 2;

/** Minimal persisted state needed to decide whether a scorecard PDF artifact must be rendered again. */
export interface ScorecardPdfArtifactState {
  pdfR2Key: string | null;
  pdfRenderVersion: number;
  linkedPhotoCount: number;
}

/**
 * Missing artifacts are always regenerated. Every legacy artifact is also regenerated: renderer v2 added
 * evidence pages, signature images/text fallback, deficiency descriptions, and stronger page guards, so a
 * photo-less card can still materially differ from its old immutable PDF.
 */
export function needsScorecardPdfRegeneration(state: ScorecardPdfArtifactState): boolean {
  const key = state.pdfR2Key?.trim();
  if (!key) return true;
  if (state.pdfRenderVersion < CURRENT_SCORECARD_PDF_RENDER_VERSION) return true;
  if (state.pdfRenderVersion > CURRENT_SCORECARD_PDF_RENDER_VERSION) return false;

  // During the initial rolling deploy, a pre-version server can finish late and update only pdf_r2_key,
  // leaving the new pdf_render_version untouched. Treat that key/version mismatch as stale so the next
  // download repairs the pointer to the version-specific object.
  return !isContentAddressedScorecardPdfKey(key, CURRENT_SCORECARD_PDF_RENDER_VERSION);
}

/** True only for the immutable SHA-256 key shape emitted by the current artifact publisher. */
export function isContentAddressedScorecardPdfKey(key: string, renderVersion: number): boolean {
  if (!Number.isInteger(renderVersion) || renderVersion < 1) return false;
  return new RegExp(`\\.[a-f0-9]{64}\\.v${renderVersion}\\.pdf$`).test(key);
}

/** HEAD-level validity check used before presigning a supposedly current immutable artifact. */
export function isScorecardPdfObjectMetadataValid(
  metadata: { contentType?: string; contentLength?: number } | null,
): boolean {
  if (!metadata?.contentLength || metadata.contentLength < 5) return false;
  const contentType = metadata.contentType?.split(";")[0]?.trim().toLowerCase();
  return !contentType || contentType === "application/pdf";
}

/**
 * Stable active-evidence identity used to detect visibility/caption races across the slow render window.
 * Hash a canonical tuple list rather than joining raw captions: captions may contain arbitrary delimiters,
 * and callers may safely use the compact opaque result in an immutable artifact key.
 */
export function scorecardEvidenceFingerprint(
  rows: Array<{ fileId: string; isActive: boolean; deletedAt: unknown; caption?: string | null }>,
): string {
  const activeEvidence = rows
    .filter((row) => row.isActive && row.deletedAt == null)
    .map((row) => [row.fileId, row.caption ?? null] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  return createHash("sha256").update(JSON.stringify(activeEvidence)).digest("hex");
}

const inFlightFinalizations = new Map<string, Promise<string | null>>();

/**
 * Process-local single-flight for the submit/download race and double-clicked downloads. Content-addressed
 * R2 keys plus fingerprint validation/monotonic DB writes remain the cross-instance safety boundary; this
 * map avoids duplicating the expensive image downloads/transcodes within one server process.
 */
export function coalesceScorecardPdfFinalization(
  key: string,
  factory: () => Promise<string | null>,
): Promise<string | null> {
  const existing = inFlightFinalizations.get(key);
  if (existing) return existing;

  const pending = factory();
  inFlightFinalizations.set(key, pending);
  const clear = () => {
    if (inFlightFinalizations.get(key) === pending) inFlightFinalizations.delete(key);
  };
  pending.then(clear, clear);
  return pending;
}
