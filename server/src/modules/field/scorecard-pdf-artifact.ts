import { createHash } from "node:crypto";

/**
 * Revision of the scorecard PDF renderer currently deployed by the server.
 *
 * Version 1 is the legacy/unversioned artifact. Version 2 embeds linked evidence photos. Version 3 adds the
 * corrective-action record (per-item status, responder, comment and response photos). Keeping this
 * independent of the scorecard form version lets artifact upgrades occur without changing scoring data.
 */
export const CURRENT_SCORECARD_PDF_RENDER_VERSION = 3;

/** Minimal persisted state needed to decide whether a scorecard PDF artifact must be rendered again. */
export interface ScorecardPdfArtifactState {
  pdfR2Key: string | null;
  pdfRenderVersion: number;
  linkedPhotoCount: number;
  /** The scorecard updated_at the stored artifact was rendered from (migration 0200); null pre-migration. */
  pdfContentGeneration: Date | string | null;
  /** The scorecard's CURRENT updated_at. null only when the row could not be read. */
  currentGeneration: Date | string | null;
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

  // Content changed since the artifact was rendered — an edit, or a corrective-action response. The
  // key/version pair alone cannot see this: a content-addressed key stays valid-looking forever, which is
  // exactly why a documented corrective action never reached the downloaded PDF.
  if (!isRenderedGenerationCurrent(state)) return true;

  // During the initial rolling deploy, a pre-version server can finish late and update only pdf_r2_key,
  // leaving the new pdf_render_version untouched. Treat that key/version mismatch as stale so the next
  // download repairs the pointer to the version-specific object.
  return !isContentAddressedScorecardPdfKey(key, CURRENT_SCORECARD_PDF_RENDER_VERSION);
}

/**
 * Whether the stored artifact was rendered from the scorecard's current content.
 *
 * A null RENDERED generation (every pre-0200 row) is stale. A null CURRENT generation means the row could
 * not be read — treated as current so a vanished/unreadable card cannot spin the download in an endless
 * regenerate loop; the caller's own 404/availability handling owns that case.
 *
 * Compared at millisecond precision: node-postgres materializes timestamps as millisecond Date objects
 * while Postgres retains microseconds, so a raw comparison would report every artifact stale forever.
 */
function isRenderedGenerationCurrent(state: ScorecardPdfArtifactState): boolean {
  if (state.currentGeneration == null) return true;
  if (state.pdfContentGeneration == null) return false;
  const rendered = toEpochMillis(state.pdfContentGeneration);
  const current = toEpochMillis(state.currentGeneration);
  // An unparseable timestamp on either side must not silently read as "current" (NaN !== NaN would make
  // every comparison stale, which is the safe direction, but be explicit about it).
  if (Number.isNaN(rendered) || Number.isNaN(current)) return false;
  return rendered === current;
}

function toEpochMillis(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
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
