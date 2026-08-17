// Immutable artifact bookkeeping for the weekly-report PDF, following field/scorecard-pdf-artifact.ts.
//
// The same two problems, and the same two answers:
//   • Rolling deploys — two server revisions render different documents from the same row, so the RENDER
//     VERSION is part of the object key and of the publication CAS. An old instance finishing late cannot
//     point the row at its older layout.
//   • Concurrent same-revision renders — two instances can render the same report at once, so the object
//     key also carries the SHA-256 of the finished bytes. A loser leaves an orphan object; it can never
//     overwrite the object the winner published.
//
// The one deliberate difference is the staleness check. field_scorecards carries a dedicated
// `pdf_content_generation` column; weekly_reports (0222) does not, so the comparison is `updated_at`
// against `pdf_generated_at`. That works because the persist statement stamps ONLY pdf_generated_at and is
// conditioned on updated_at not having moved — so an edit after a render leaves updated_at later and the
// artifact reads stale. See isRenderedGenerationCurrent for the one narrow interleaving where Postgres's
// transaction-start `now()` defeats that, and why it is tolerated.

import { createHash } from "node:crypto";

/**
 * Revision of the weekly-report PDF renderer deployed by this server.
 *
 * Bump it for ANY change to what the page shows or where it shows it. The key and the publication CAS both
 * key on this number, so leaving it alone during a layout change means every artifact rendered before the
 * deploy keeps being served forever — the migration alone does not invalidate them.
 */
export const CURRENT_WEEKLY_REPORT_PDF_RENDER_VERSION = 1;

/**
 * Immutable, content-addressed key for one weekly-report PDF render.
 *
 * RAW `deal_number` when there is one, else the deal id — the photo-report convention, so a human browsing
 * the bucket finds a project's documents in one place. The digest is required to be a SHA-256 hex value
 * rather than merely stringified: a caller that passed something else would produce a key that
 * isContentAddressedWeeklyReportPdfKey then classifies as legacy on every read, re-rendering forever.
 */
export function weeklyReportPdfR2Key(
  officeSlug: string,
  dealNumber: string | null | undefined,
  dealId: string,
  reportId: string,
  renderVersion: number,
  pdfDigest: string,
): string {
  if (!/^[a-f0-9]{64}$/.test(pdfDigest)) {
    throw new Error("weekly report PDF digest must be a SHA-256 hex value");
  }
  const segment = dealNumber?.trim() || dealId;
  return `office_${officeSlug}/deals/${segment}/documents/weekly-reports/${reportId}.${pdfDigest}.v${renderVersion}.pdf`;
}

/** True only for the immutable key shape emitted by the current publisher at `renderVersion`. */
export function isContentAddressedWeeklyReportPdfKey(key: string, renderVersion: number): boolean {
  if (!Number.isInteger(renderVersion) || renderVersion < 1) return false;
  return new RegExp(`\\.[a-f0-9]{64}\\.v${renderVersion}\\.pdf$`).test(key);
}

export function weeklyReportPdfDigest(pdf: Buffer): string {
  return createHash("sha256").update(pdf).digest("hex");
}

/** The persisted state that decides whether the stored artifact still represents the report. */
export interface WeeklyReportPdfArtifactState {
  pdfR2Key: string | null;
  pdfRenderVersion: number;
  /** When the stored bytes were rendered. Null for a report that has never been rendered. */
  pdfGeneratedAt: Date | string | null;
  /** The report's current `updated_at`. Null only when the row could not be read. */
  updatedAt: Date | string | null;
  /**
   * True only for a `sent` report — the one state in which EVERY input to the render is frozen.
   *
   * Before send, the header block is read LIVE from `weekly_report_projects` and `public.users`, and none
   * of those tables touches `weekly_reports.updated_at` when they change. So renaming the property,
   * swapping the superintendent, correcting a contract date or soft-deleting a photo all leave a cached
   * PDF looking current while the web page — which reads live — shows something else. Since the two
   * surfaces are supposed to be the same document, an unfrozen report is simply never cached.
   *
   * Once sent, the snapshot freezes the header and the report itself is immutable, so `updated_at` becomes
   * a complete generation signal and the artifact is trustworthy indefinitely. That is also the correct
   * outcome for a photo deleted AFTER delivery: the stored PDF is the record of what the client received.
   */
  contentFrozen: boolean;
}

export function needsWeeklyReportPdfRegeneration(state: WeeklyReportPdfArtifactState): boolean {
  const key = state.pdfR2Key?.trim();
  if (!key) return true;
  if (state.pdfRenderVersion < CURRENT_WEEKLY_REPORT_PDF_RENDER_VERSION) return true;
  // A NEWER renderer's artifact. This instance must not downgrade it — the publication CAS is
  // `pdf_render_version <= CURRENT` and would match no row anyway. "Cannot supersede" is not "is current",
  // which is why isFutureRendererWeeklyReportPdfStale exists as a separate question.
  if (state.pdfRenderVersion > CURRENT_WEEKLY_REPORT_PDF_RENDER_VERSION) return false;
  // See contentFrozen: before send, updated_at is not a complete generation signal.
  if (!state.contentFrozen) return true;
  if (!isRenderedGenerationCurrent(state)) return true;
  // During the first rolling deploy a pre-version instance can write only pdf_r2_key and leave the version
  // at its default. Treat that key/version mismatch as stale so the next read repairs the pointer.
  return !isContentAddressedWeeklyReportPdfKey(key, CURRENT_WEEKLY_REPORT_PDF_RENDER_VERSION);
}

/**
 * A newer-renderer artifact whose content has ALSO moved on. This instance can neither serve it honestly
 * nor replace it, so the caller surfaces a retryable error and a retry reaches an upgraded instance.
 */
export function isFutureRendererWeeklyReportPdfStale(state: WeeklyReportPdfArtifactState): boolean {
  if (state.pdfRenderVersion <= CURRENT_WEEKLY_REPORT_PDF_RENDER_VERSION) return false;
  return !state.contentFrozen || !isRenderedGenerationCurrent(state);
}

export type WeeklyReportArtifactRecheck = "current" | "stale" | "awaiting-newer-renderer";

/**
 * Is the stored artifact safe to hand out right now, and if not, why?
 *
 * The order matters: needsWeeklyReportPdfRegeneration answers "can this instance supersede it?", which is
 * deliberately false for any future-renderer artifact — so asking it first would report a newer-renderer
 * artifact as current however far its content had drifted.
 */
export function classifyWeeklyReportArtifact(
  state: WeeklyReportPdfArtifactState,
): WeeklyReportArtifactRecheck {
  if (isFutureRendererWeeklyReportPdfStale(state)) return "awaiting-newer-renderer";
  return needsWeeklyReportPdfRegeneration(state) ? "stale" : "current";
}

/**
 * Was the stored artifact rendered from the report's current content?
 *
 * A null CURRENT generation means the row could not be read — treated as current so an unreadable report
 * cannot spin a download in an endless regenerate loop; the caller's own 404 handling owns that case.
 *
 * Compared at MILLISECOND precision, because node-postgres materialises timestamps as millisecond Date
 * objects while Postgres retains microseconds. `<=` rather than `<`: the publish transaction can begin
 * inside the same millisecond as the edit it rendered, and a strict comparison would then call a
 * freshly-published artifact stale on the very next read and re-render on every download forever.
 *
 * KNOWN NARROW RACE, tolerated deliberately. Postgres `now()` is TRANSACTION-START time, so an edit
 * transaction that began before the publish transaction but commits after the publication CAS stamps an
 * `updated_at` earlier than the `pdf_generated_at` just written — and this then reads as current though the
 * content moved. It requires an edit request to span the publish transaction's few milliseconds exactly;
 * any earlier commit fails the CAS cleanly instead. It also self-heals: the artifact only matters for an
 * approved report, and moving that report to `sent` writes `updated_at` again in a later transaction, so
 * the PDF the client actually receives is re-rendered from current content. Closing it properly would mean
 * a dedicated content-generation column (as field_scorecards has), which 0222 does not carry.
 */
function isRenderedGenerationCurrent(state: WeeklyReportPdfArtifactState): boolean {
  if (state.updatedAt == null) return true;
  if (state.pdfGeneratedAt == null) return false;
  const rendered = toEpochMillis(state.pdfGeneratedAt);
  const current = toEpochMillis(state.updatedAt);
  if (Number.isNaN(rendered) || Number.isNaN(current)) return false;
  return current <= rendered;
}

function toEpochMillis(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}
