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
// Staleness is decided by comparing two CONTENT GENERATIONS, never a generation against a clock. The
// report's current generation is `updated_at`, widened before send to cover the rows the render reads live;
// the stored artifact's is `pdf_content_generation` (0224), which records the generation the bytes were
// rendered FROM — captured before the render starts, not stamped when it finishes.
//
// That distinction is the whole point, and getting it wrong is not a millisecond race. A render takes as
// long as it takes to download and transcode every photo; a photo soft-deleted or a superintendent swapped
// while it runs moves none of the timestamps a report-row CAS can see. Stamping wall-clock time on
// completion therefore records an instant LATER than a change the bytes do not contain, and every later
// read calls the artifact current — permanently, because `approved` is where a shared report sits and
// nothing moves `updated_at` again. Recording what was rendered instead leaves the live generation ahead of
// the stored one, so the next read classifies it stale and re-renders. See 0224.
//
// A generation is carried as TEXT at Postgres's own resolution — see weeklyReportGenerationSql. Comparing
// two generations at a coarser resolution than the database stores them at reopens the same hole one layer
// down: `timestamptz` is microseconds, node-postgres materialises it as a millisecond JS Date, and two
// generations 500µs apart then compare EQUAL. `current <= rendered` holds, the artifact classifies current,
// and a report row, a photo selection or a header field that moved inside that millisecond is served from
// the cache forever — for a `sent` report, forever literally, because nothing moves `updated_at` again.

import { createHash } from "node:crypto";

/**
 * A content generation in its canonical form: `YYYY-MM-DDTHH:MM:SS.ffffffZ`.
 *
 * Fixed width, always UTC, always six fractional digits — Postgres's own `timestamptz` resolution, carried
 * as text because node-postgres hands back a millisecond JS `Date` and the microseconds are gone before any
 * of this code sees them. Selecting the columns THROUGH THIS EXPRESSION is what keeps them.
 *
 * The offset is pinned to `Z` rather than emitted with `OF` so the text does not change with the session
 * TimeZone: the same instant must produce the same generation on every connection, or the publication CAS
 * compares a value against a differently-spelled copy of itself.
 *
 * Give it a `timestamptz`. On a naive `timestamp` the same `AT TIME ZONE 'UTC'` converts the OTHER way —
 * to a timestamptz, which `to_char` then renders in the session TimeZone — and the `Z` becomes a lie.
 *
 * `$n::timestamptz` parses this back to the exact microsecond it came from, so the same string serves as
 * the value read, the value compared, and the value written — see weeklyReportContentGeneration.
 */
export function weeklyReportGenerationSql(expression: string): string {
  return `to_char(${expression} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

const CANONICAL_GENERATION = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/**
 * Normalise anything a caller might hold into the canonical generation text, or null if it is not a time.
 *
 * A `Date` is accepted, and WIDENED with three zero microseconds — a JS Date never had them, so recording
 * `.123000` is the honest reading of `.123`. That path is for callers that genuinely only have a Date; the
 * loader must not use it, because a generation read as a Date and one read as text are not comparable: the
 * text side keeps `.123456` while the Date side claims `.123000`, and the artifact then reads stale on
 * every single download. Everything the PDF path reads comes through weeklyReportGenerationSql.
 */
export function weeklyReportGeneration(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (CANONICAL_GENERATION.test(trimmed)) return trimmed;
    return widenToMicroseconds(new Date(trimmed));
  }
  return widenToMicroseconds(value);
}

function widenToMicroseconds(value: Date): string | null {
  if (Number.isNaN(value.getTime())) return null;
  return `${value.toISOString().slice(0, -1)}000Z`;
}

/**
 * Epoch MICROSECONDS for a canonical generation, or NaN when it is not one.
 *
 * A number rather than a lexicographic comparison of the text: the canonical shape does order correctly
 * under `<=`, but only while every value is a four-digit year with the same offset, and a comparison that
 * is right by coincidence of formatting is the kind that fails silently. Epoch microseconds for a
 * contemporary timestamp are ~1.8e15, comfortably inside Number.MAX_SAFE_INTEGER (9.0e15, reached in 2255).
 */
function toEpochMicroseconds(generation: string): number {
  const match = /^(.*)\.(\d{6})Z$/.exec(generation);
  if (!match) return Number.NaN;
  const wholeSecondsMs = Date.parse(`${match[1]!}Z`);
  if (Number.isNaN(wholeSecondsMs)) return Number.NaN;
  return wholeSecondsMs * 1000 + Number(match[2]!);
}

/** The newest of several generations, canonicalised, or null when every one is absent or unparseable. */
export function newestWeeklyReportGeneration(
  values: Array<Date | string | null | undefined>,
): string | null {
  let newest: string | null = null;
  let newestMicros = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    const generation = weeklyReportGeneration(value);
    if (generation == null) continue;
    const micros = toEpochMicroseconds(generation);
    if (Number.isNaN(micros) || micros <= newestMicros) continue;
    newest = generation;
    newestMicros = micros;
  }
  return newest;
}

/**
 * Revision of the weekly-report PDF renderer deployed by this server.
 *
 * Bump it for ANY change to what the page shows or where it shows it. The key and the publication CAS both
 * key on this number, so leaving it alone during a layout change means every artifact rendered before the
 * deploy keeps being served forever — the migration alone does not invalidate them.
 *
 * v2: long sections flow onto continuation pages instead of stopping at 6,000 characters, and a superseded
 * report prints its notice.
 * v3: a photo's caption band is MEASURED rather than fixed at two lines, so the PDF prints the same caption
 * the web page does; the photograph takes whatever the caption leaves.
 * v4: a caption's whitespace is collapsed the way the client's page already displays it, and a caption too
 * tall for its band is set a size smaller rather than ellipsised — so a line-broken or long-worded caption
 * prints in full on both surfaces instead of losing its tail in the PDF alone.
 *
 * The number is asserted LITERALLY in pdf-artifact.test.ts, deliberately. Every other test binds this
 * constant, so nothing else can notice it disagreeing with the renderer — and a layout change that forgets
 * to bump it leaves every artifact rendered before the deploy being served forever, which is invisible
 * until a client asks why their PDF does not match their page.
 */
export const CURRENT_WEEKLY_REPORT_PDF_RENDER_VERSION = 4;

/** The key segment that records a render made while the report was already superseded. */
const SUPERSEDED_KEY_MARKER = ".superseded";

/**
 * Immutable, content-addressed key for one weekly-report PDF render.
 *
 * RAW `deal_number` when there is one, else the deal id — the photo-report convention, so a human browsing
 * the bucket finds a project's documents in one place. The digest is required to be a SHA-256 hex value
 * rather than merely stringified: a caller that passed something else would produce a key that
 * isContentAddressedWeeklyReportPdfKey then classifies as legacy on every read, re-rendering forever.
 *
 * `superseded` is carried in the key rather than left implicit in the digest because the KEY is all a later
 * read has. Being superseded is the one input to the render that can change without changing the report's
 * own content generation — the correction lands on a different row — so without a marker here a report
 * superseded after publication would keep serving an unmarked PDF indefinitely.
 */
export function weeklyReportPdfR2Key(
  officeSlug: string,
  dealNumber: string | null | undefined,
  dealId: string,
  reportId: string,
  renderVersion: number,
  pdfDigest: string,
  superseded = false,
): string {
  if (!/^[a-f0-9]{64}$/.test(pdfDigest)) {
    throw new Error("weekly report PDF digest must be a SHA-256 hex value");
  }
  const segment = dealNumber?.trim() || dealId;
  const marker = superseded ? SUPERSEDED_KEY_MARKER : "";
  return `office_${officeSlug}/deals/${segment}/documents/weekly-reports/${reportId}.${pdfDigest}.v${renderVersion}${marker}.pdf`;
}

/** True only for the immutable key shape emitted by the current publisher at `renderVersion`. */
export function isContentAddressedWeeklyReportPdfKey(key: string, renderVersion: number): boolean {
  if (!Number.isInteger(renderVersion) || renderVersion < 1) return false;
  return new RegExp(`\\.[a-f0-9]{64}\\.v${renderVersion}(\\${SUPERSEDED_KEY_MARKER})?\\.pdf$`).test(key);
}

/** Whether the stored object is the SUPERSEDED rendering of the report, read back off its own key. */
export function weeklyReportPdfKeyMarksSuperseded(key: string): boolean {
  return key.trim().endsWith(`${SUPERSEDED_KEY_MARKER}.pdf`);
}

export function weeklyReportPdfDigest(pdf: Buffer): string {
  return createHash("sha256").update(pdf).digest("hex");
}

/**
 * The persisted state that decides whether the stored artifact still represents the report.
 *
 * Every generation below is canonical text — see weeklyReportGenerationSql. `Date` is in the type only for
 * callers that have nothing better; feeding one in from the loader would silently claim `.000` microseconds
 * for a value the database stores to the microsecond, and MIXING the two representations across a
 * comparison is worse than either alone.
 */
export interface WeeklyReportPdfArtifactState {
  pdfR2Key: string | null;
  pdfRenderVersion: number;
  /**
   * The content generation the stored bytes were rendered FROM, read back off the row. Null for a report
   * that has never been rendered — and for one whose key predates 0224, which reads stale and re-renders
   * once.
   *
   * NOT "when the render finished". The publisher captures this before the render begins and writes that
   * value verbatim, so a change landing mid-render stays visible as a generation the artifact does not
   * cover. See the file header.
   */
  pdfContentGeneration: Date | string | null;
  /** The report's current `updated_at`. Null only when the row could not be read. */
  updatedAt: Date | string | null;
  /**
   * Newest generation among the rows the render reads LIVE and which do NOT touch this report's
   * `updated_at` — the `weekly_report_projects` setup row, the two `public.users` rows it names, and the
   * selected photos' `files` rows. Null when there are none.
   *
   * Counted only while the report is unfrozen, and this is what makes an APPROVED report cacheable at all.
   * Renaming the property, swapping the superintendent, correcting a contract date or soft-deleting a photo
   * from the Files tab all used to leave a cached PDF looking current while the web page, which reads live,
   * showed something else. The previous answer was to cache nothing before send — which meant every
   * anonymous request on an approved report re-rendered and re-uploaded a new content-addressed object,
   * with no path that deletes the last one.
   *
   * A photo row HARD-deleted rather than soft-deleted lowers the maximum instead of raising it, and is the
   * one live change this cannot see. It only happens through the permanent-delete cascade, which takes the
   * report with it.
   */
  liveInputGeneration: Date | string | null;
  /**
   * `deals.updated_at`, and ONLY when the render's property name falls through to `deals.name` — i.e.
   * neither the snapshot nor the setup row names the property. Null otherwise, which is the ordinary case.
   *
   * Kept apart from liveInputGeneration because it counts even while the report is FROZEN. The fallback is
   * the one input a sent report still reads live (see WeeklyReportViewInput.dealName), so a rename would
   * otherwise change the client's page while the frozen PDF behind the same link kept the old name — for
   * good, since nothing re-renders a sent report. Null in every other case, so an ordinary deal edit does
   * not invalidate a cached PDF that does not depend on the deal at all.
   */
  dealNameGeneration: Date | string | null;
  /**
   * True only for a `sent` report — the one state in which EVERY input to the render is frozen.
   *
   * The snapshot freezes the header and the report itself is immutable, so the live rows above stop
   * counting entirely: a PM swapped in September must not invalidate August's delivered PDF. Same for a
   * photo deleted AFTER delivery — the stored PDF is the record of what the client received.
   */
  contentFrozen: boolean;
  /** Whether a correction has replaced this version. Printed by the renderer, so part of the identity. */
  superseded: boolean;
}

export function needsWeeklyReportPdfRegeneration(state: WeeklyReportPdfArtifactState): boolean {
  const key = state.pdfR2Key?.trim();
  if (!key) return true;
  if (state.pdfRenderVersion < CURRENT_WEEKLY_REPORT_PDF_RENDER_VERSION) return true;
  // A NEWER renderer's artifact. This instance must not downgrade it — the publication CAS is
  // `pdf_render_version <= CURRENT` and would match no row anyway. "Cannot supersede" is not "is current",
  // which is why isFutureRendererWeeklyReportPdfStale exists as a separate question.
  if (state.pdfRenderVersion > CURRENT_WEEKLY_REPORT_PDF_RENDER_VERSION) return false;
  if (!isRenderedGenerationCurrent(state)) return true;
  // Being superseded moves no timestamp on this row — the correction is a DIFFERENT row — so it is read
  // back off the stored key instead. One re-render, and the repaired key then reads current forever.
  if (state.superseded !== weeklyReportPdfKeyMarksSuperseded(key)) return true;
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
  const key = state.pdfR2Key?.trim();
  if (!key) return true;
  if (!isRenderedGenerationCurrent(state)) return true;
  return state.superseded !== weeklyReportPdfKeyMarksSuperseded(key);
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
 * The instant a stored artifact has to be at least as new as.
 *
 * `weekly_reports.updated_at` alone before send, widened by the generations of every other row the render
 * reads live — see WeeklyReportPdfArtifactState.liveInputGeneration for why they have to count and why they
 * stop counting once the report is frozen.
 *
 * The ONE definition of a generation, used three ways so they cannot drift: the render coalescer keys on it
 * (two requests either side of a header edit want different documents and must not share one in-flight
 * render), the publisher WRITES the value it read into pdf_content_generation, and the comparison above
 * reads it back. Anything that changes what the render sees must move this, or a cached PDF outlives it.
 *
 * All three now share one REPRESENTATION as well as one definition — the canonical text this returns is the
 * coalescer key segment verbatim, the `$n::timestamptz` the publisher binds verbatim, and the left-hand side
 * of the comparison verbatim. That is deliberate: the moment the key, the written value and the comparison
 * are allowed to disagree about resolution, an artifact can be published under one generation and read back
 * as covering a different one.
 */
export function weeklyReportContentGeneration(state: WeeklyReportPdfArtifactState): string | null {
  // Null updated_at means the row could not be read; a widened maximum over the remaining inputs would be a
  // generation for a report nobody has actually seen. The caller's 404 handling owns that case.
  if (state.updatedAt == null) return null;
  return newestWeeklyReportGeneration([
    state.updatedAt,
    // Frozen or not — see dealNameGeneration. It is null unless the render actually reads `deals.name`.
    state.dealNameGeneration,
    state.contentFrozen ? null : state.liveInputGeneration,
  ]);
}

/**
 * Was the stored artifact rendered from the report's current content?
 *
 * BOTH SIDES ARE CONTENT GENERATIONS. The left is what the report says now, the right is what the stored
 * bytes were rendered from; neither is a wall-clock reading of when any work happened. That is what makes
 * the comparison total rather than approximate — every input the render reads either moves the current
 * generation or is frozen, so an artifact that does not cover a change cannot read as covering it.
 *
 * A null CURRENT generation means the row could not be read — treated as current so an unreadable report
 * cannot spin a download in an endless regenerate loop; the caller's own 404 handling owns that case.
 *
 * Compared at MICROSECOND precision — Postgres's own `timestamptz` resolution, and the resolution both
 * sides are read at (weeklyReportGenerationSql). Rounding to milliseconds first, which is all a JS `Date`
 * can hold, makes two generations less than a millisecond apart compare EQUAL, and `<=` then classifies the
 * artifact current: the page shows the edit, the cached PDF does not, and for a `sent` report nothing ever
 * moves `updated_at` again to break the tie. A render reads its inputs and publishes microseconds later, so
 * the sub-millisecond window is not hypothetical — it is exactly where a concurrent edit lands.
 *
 * `<=` rather than `<`: the publisher writes the generation it read, so a quiet report compares exactly
 * EQUAL on every subsequent read, and a strict comparison would call every freshly-published artifact stale
 * and re-render on every download forever.
 */
function isRenderedGenerationCurrent(state: WeeklyReportPdfArtifactState): boolean {
  const generation = weeklyReportContentGeneration(state);
  if (generation == null) return true;
  const renderedGeneration = weeklyReportGeneration(state.pdfContentGeneration);
  if (renderedGeneration == null) return false;
  const rendered = toEpochMicroseconds(renderedGeneration);
  const current = toEpochMicroseconds(generation);
  if (Number.isNaN(rendered) || Number.isNaN(current)) return false;
  return current <= rendered;
}
