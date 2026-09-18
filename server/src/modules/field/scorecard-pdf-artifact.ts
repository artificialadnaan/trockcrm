import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
  SCORECARD_GENERATION_SQL_PREFIX,
  SCORECARD_GENERATION_SQL_SUFFIX,
  scorecardGenerationsMatch,
} from "@trock-crm/shared/lib/scorecardGeneration";

/**
 * A `timestamptz` column read as CANONICAL MICROSECOND TEXT, for a Drizzle select list.
 *
 * The one and only way the PDF cache is allowed to read a content generation. Selecting the column itself
 * hands back a JS `Date`, which is milliseconds: every digit Postgres stores below that is discarded before
 * any of this code sees it, and a comparison, a CAS bound or a stored value built from what survives is a
 * thousand-fold coarser than the data it claims to describe. See shared/src/lib/scorecardGeneration.ts.
 *
 * The formatter is SPLICED from the shared constants around the column reference rather than restated here,
 * so the server's Drizzle fragment and the worker's raw SQL cannot drift into two spellings of "the
 * canonical generation". Passing the column object (not a literal name) lets Drizzle qualify it, which
 * matters on the joined artifact-state reads where `files` also has an `updated_at`.
 */
export function scorecardGenerationColumn(column: AnyPgColumn) {
  return sql<
    string
  >`${sql.raw(SCORECARD_GENERATION_SQL_PREFIX)}${column}${sql.raw(SCORECARD_GENERATION_SQL_SUFFIX)}`;
}

/**
 * Revision of the scorecard PDF renderer currently deployed by the server.
 *
 * Version 1 is the legacy/unversioned artifact. Version 2 embeds linked evidence photos. Version 3 adds the
 * corrective-action record (per-item status, responder, comment and response photos). Version 4 replaces
 * that record's two-state open/resolved rows with the four-state approval THREAD — every submission, every
 * rejection with its reason, the approval that closed it.
 *
 * v4 is a required bump, not cosmetic. The publish CAS and the regeneration check both key on this number,
 * so leaving it at 3 during a rolling deploy would let an OLD instance publish a v3-shaped artifact for a
 * new generation, after which upgraded instances classify it as current forever — and every artifact cached
 * before this deploy would keep serving the pre-approval layout, because the migration alone does not
 * invalidate them.
 *
 * Keeping this independent of the scorecard form version lets artifact upgrades occur without changing
 * scoring data.
 */
export const CURRENT_SCORECARD_PDF_RENDER_VERSION = 4;

/**
 * Minimal persisted state needed to decide whether a scorecard PDF artifact must be rendered again.
 *
 * BOTH generations must be loaded THE SAME WAY, and the way is `scorecardGenerationColumn` — canonical
 * microsecond text. `Date` remains in the type for the callers that genuinely have nothing better (test
 * fixtures, and the worker's mocked rows), and `scorecardGeneration` widens one honestly with `.000`
 * microseconds; but a state that mixes a `Date` on one side with database text on the other compares a
 * widened `.123000` against a true `.123456` and reads stale on every download, forever. See
 * shared/src/lib/scorecardGeneration.ts.
 */
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
  // A NEWER renderer's artifact. This instance must not downgrade it — its publish CAS is
  // `lte(pdf_render_version, CURRENT)` and would match no row anyway — but "cannot supersede" is not the same
  // as "is current": if a corrective-action response has advanced updated_at since that render, serving it
  // reproduces the exact bug this work fixes, silently and indefinitely for every download that lands on an
  // old instance. Callers get a RETRYABLE signal instead, so the retry can reach an upgraded instance that
  // can actually re-render. See isFutureRendererArtifactStale.
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
 * A newer-renderer artifact whose generation is ALSO stale — this instance can neither serve it honestly nor
 * replace it, so the caller should surface a retryable error rather than presign known-stale bytes.
 *
 * Only true during a rolling deploy (or a rollback) where a higher-version artifact exists. Deliberately
 * narrow: a future-version artifact whose generation still MATCHES is perfectly serviceable and returns false.
 */
export function isFutureRendererArtifactStale(state: ScorecardPdfArtifactState): boolean {
  if (state.pdfRenderVersion <= CURRENT_SCORECARD_PDF_RENDER_VERSION) return false;
  return !isRenderedGenerationCurrent(state);
}

/** Outcome of the pre-presign recheck. Both non-current verdicts are retryable, for different reasons. */
export type ScorecardArtifactRecheck = "current" | "stale" | "awaiting-newer-renderer";

/**
 * Is this artifact safe to presign RIGHT NOW, and if not, why?
 *
 * The order matters and is the whole point: needsScorecardPdfRegeneration answers "can this instance supersede
 * it?", which is deliberately FALSE for any future-renderer artifact — so asking it first reports a
 * newer-renderer artifact as current no matter how far its generation has drifted. That is how a download
 * could still serve a PDF missing its corrective action despite a route-level guard for exactly that case.
 */
export function classifyScorecardArtifactRecheck(state: ScorecardPdfArtifactState): ScorecardArtifactRecheck {
  if (isFutureRendererArtifactStale(state)) return "awaiting-newer-renderer";
  return needsScorecardPdfRegeneration(state) ? "stale" : "current";
}

/**
 * Whether the stored artifact was rendered from the scorecard's current content.
 *
 * A null RENDERED generation (every pre-0200 row) is stale. A null CURRENT generation means the row could
 * not be read — treated as current so a vanished/unreadable card cannot spin the download in an endless
 * regenerate loop; the caller's own 404/availability handling owns that case. An unparseable value on
 * either side is stale, which is the safe direction; scorecardGenerationsMatch owns that.
 *
 * Compared at MICROSECOND precision — Postgres's own `timestamptz` resolution, and the resolution both
 * sides are read at (scorecardGenerationColumn here, scorecardGenerationSql in the worker). This used to
 * round both sides to milliseconds, which is all a JS `Date` can hold, so two generations less than a
 * millisecond apart compared EQUAL: a render that read the pre-response card published under a generation
 * indistinguishable from the post-response one, this check called the result current, and the download
 * served a PDF missing the corrective action — the exact defect migration 0200 exists to prevent. See
 * shared/src/lib/scorecardGeneration.ts.
 */
function isRenderedGenerationCurrent(state: ScorecardPdfArtifactState): boolean {
  if (state.currentGeneration == null) return true;
  if (state.pdfContentGeneration == null) return false;
  return scorecardGenerationsMatch(state.pdfContentGeneration, state.currentGeneration);
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
