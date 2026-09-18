import { AppError } from "../../middleware/error-handler.js";
import { generateDownloadUrl, isR2Configured, putObject } from "../../lib/r2-client.js";
import { withWeeklyReportOfficeClient } from "./office-connection.js";
import {
  CURRENT_WEEKLY_REPORT_PDF_RENDER_VERSION,
  classifyWeeklyReportArtifact,
  newestWeeklyReportGeneration,
  weeklyReportContentGeneration,
  weeklyReportGeneration,
  weeklyReportGenerationSql,
  weeklyReportPdfDigest,
  weeklyReportPdfR2Key,
  type WeeklyReportArtifactRecheck,
  type WeeklyReportPdfArtifactState,
} from "./pdf-artifact.js";
import {
  renderWeeklyReportPdf,
  weeklyReportRenderTimeoutMs,
  type WeeklyReportPdfPhoto,
} from "./pdf.js";
import { buildWeeklyReportView, type WeeklyReportView } from "./report-view.js";
import { trockTeamColumns, trockTeamJoins, type QueryExecutor } from "./projects-service.js";

// Read → render → upload → publish, with the DB connection released across the slow middle.
//
// The render downloads and transcodes every photo and the upload is a network PUT; a request that held its
// pooled connection through both would tie one up for seconds per download. That is the documented cause of
// "Couldn't load deals" in this codebase, so the phases are separated: the caller loads inside its own
// transaction and COMMITS, and only then calls publishWeeklyReportPdf, which takes its own short connection
// for the publication CAS.

/** Matches the 1-hour presign the scorecard download uses — long enough to click, short enough to expire. */
const PDF_DOWNLOAD_EXPIRY_SECONDS = 60 * 60;

export interface WeeklyReportPdfSource {
  reportId: string;
  dealId: string;
  dealNumber: string | null;
  /** Set when a correction superseded this version. The old link keeps resolving and says so. */
  supersededById: string | null;
  /**
   * The `updated_at` this data was read at — the value the publication CAS is conditioned on, as canonical
   * microsecond text (weeklyReportGenerationSql). The CAS matches it EXACTLY, so anything that rounds it
   * would let a report edited inside the same millisecond as the read pass a CAS that exists to stop it.
   */
  updatedAt: string | null;
  view: WeeklyReportView;
  state: WeeklyReportPdfArtifactState;
  recheck: WeeklyReportArtifactRecheck;
}

const PHOTO_SELECT = `
  SELECT wrp.file_id, wrp.caption, wrp.sort_order,
         f.r2_key, f.external_url, f.external_thumbnail_url, f.mime_type
    FROM weekly_report_photos wrp
    JOIN files f ON f.id = wrp.file_id
   WHERE wrp.weekly_report_id = $1::uuid
     AND f.is_active = true
     AND f.deleted_at IS NULL
   ORDER BY wrp.sort_order ASC, wrp.created_at ASC
`;

async function loadPhotos(client: QueryExecutor, reportId: string): Promise<WeeklyReportPdfPhoto[]> {
  const result = await client.query(PHOTO_SELECT, [reportId]);
  return result.rows.map((row: Record<string, any>) => ({
    fileId: row.file_id,
    caption: row.caption ?? null,
    r2Key: row.r2_key ?? null,
    externalUrl: row.external_url ?? null,
    externalThumbnailUrl: row.external_thumbnail_url ?? null,
    mimeType: row.mime_type ?? null,
  }));
}

/**
 * Everything the renderer needs, read in ONE pass so the artifact state and the content it describes come
 * from the same snapshot of the row. Returns null for a report that does not exist (or was deactivated).
 *
 * The live setup row is joined unconditionally, but `buildWeeklyReportView` only consults it when the
 * report carries no snapshot — a sent report renders from its own frozen copy.
 */
export async function loadWeeklyReportPdfSource(
  client: QueryExecutor,
  reportId: string,
): Promise<WeeklyReportPdfSource | null> {
  const result = await client.query(
    `SELECT wr.*,
            -- PostgreSQL date is a calendar value, not an instant. Keep it as text rather than letting
            -- node-postgres turn local midnight into a Date that a later UTC conversion can shift.
            wr.week_of::text AS report_week_of,
            d.name           AS deal_name,
            d.deal_number    AS deal_number,
            proj.property_display_name, proj.client_name,
            proj.client_doc_name, proj.client_pm_name, proj.client_rm_name, proj.client_cm_name,
            proj.trock_pm_user_id, proj.trock_super_user_id,
            -- EVERY generation below is selected as canonical microsecond TEXT, never as the timestamptz
            -- itself: node-postgres parses timestamptz into a millisecond JS Date, so reading one straight
            -- throws away the microseconds Postgres stored — and two generations inside the same
            -- millisecond then compare equal, which is the whole thing the comparison exists to catch. The
            -- report's own updated_at is aliased rather than taken from wr.* because the raw Date is still
            -- what the renderer pins /CreationDate to (see report-view.ts).
            ${weeklyReportGenerationSql("wr.updated_at")}             AS updated_at_generation,
            ${weeklyReportGenerationSql("wr.pdf_content_generation")} AS rendered_generation,
            -- The generations of everything the render reads that is NOT the report row. None of these
            -- touches weekly_reports.updated_at when it changes; see liveInputGeneration.
            -- deals is joined for the NAME, which the header falls back to when nothing else supplies a
            -- property name, so its generation has to be available too; see dealNameGeneration for why it
            -- is conditional and why it counts even for a frozen report.
            ${weeklyReportGenerationSql("d.updated_at")}    AS deal_generation,
            ${weeklyReportGenerationSql("proj.updated_at")} AS project_generation,
            -- GREATEST of the ROSTER row and the login, because after 0228 the name that prints comes
            -- from the roster and falls back to the login. Stamping only the login would leave a cached
            -- PDF showing the old name after a director corrects a roster spelling — the document would
            -- keep disagreeing with the CRM until something unrelated invalidated it. Postgres's GREATEST
            -- ignores NULLs and returns NULL only when every argument is NULL, which is exactly right for
            -- an unassigned slot and for a roster person who holds no login.
            ${weeklyReportGenerationSql("GREATEST(pm_fr.updated_at, pm_u.updated_at)")}   AS trock_pm_generation,
            ${weeklyReportGenerationSql("GREATEST(sup_fr.updated_at, sup_u.updated_at)")} AS trock_super_generation,
            -- Deliberately NOT filtered to the photos the render keeps. A soft delete leaves the row in
            -- place and stamps deleted_at without touching updated_at, so counting only live photos would
            -- miss the very change that removes one from the document.
            ${weeklyReportGenerationSql(`(SELECT max(GREATEST(f.updated_at, COALESCE(f.deleted_at, f.updated_at)))
               FROM weekly_report_photos wrp
               JOIN files f ON f.id = wrp.file_id
              WHERE wrp.weekly_report_id = wr.id)`)} AS photo_generation,
            proj.contract_date, proj.contract_date_note,
            proj.project_start_date, proj.project_start_date_note,
            proj.project_completion_date, proj.project_completion_date_note,
            proj.projected_duration_weeks AS project_projected_duration_weeks,
${trockTeamColumns()}
       FROM weekly_reports wr
       JOIN deals d ON d.id = wr.deal_id
       LEFT JOIN weekly_report_projects proj ON proj.id = wr.weekly_report_project_id
${trockTeamJoins("proj")}
      WHERE wr.id = $1::uuid AND wr.is_active
      LIMIT 1`,
    [reportId],
  );
  const row = result.rows[0];
  if (!row) return null;

  const view = buildWeeklyReportView({
    report: { ...row, week_of: row.report_week_of },
    // The joined columns ARE the live setup row; `projected_duration_weeks` is aliased above because the
    // report carries a column of the same name and the report's value is the authoritative one.
    project: { ...row, projected_duration_weeks: row.project_projected_duration_weeks },
    dealName: row.deal_name,
    photos: await loadPhotos(client, reportId),
  });

  const state: WeeklyReportPdfArtifactState = {
    pdfR2Key: row.pdf_r2_key ?? null,
    pdfRenderVersion: Number(row.pdf_render_version ?? 0),
    // NOT pdf_generated_at. That column records when a render finished, which is a clock reading and not
    // comparable with a content generation — see the pdf-artifact.ts header for what comparing them cost.
    pdfContentGeneration: row.rendered_generation ?? null,
    updatedAt: row.updated_at_generation ?? null,
    liveInputGeneration: newestWeeklyReportGeneration([
      row.project_generation,
      row.trock_pm_generation,
      row.trock_super_generation,
      row.photo_generation,
    ]),
    // Asked of the VIEW rather than re-deriving "is the property name blank?" here. Two opinions about the
    // same fallback is how an input slips out of a generation: the view decides what is printed, so it is
    // the only thing that can say whether `deals.name` was one of the inputs.
    dealNameGeneration: view.propertyNameFromDeal ? (row.deal_generation ?? null) : null,
    // Only a sent report has every input frozen — see WeeklyReportPdfArtifactState.contentFrozen.
    contentFrozen: row.status === "sent",
    superseded: row.superseded_by_id != null,
  };

  return {
    reportId,
    dealId: row.deal_id,
    dealNumber: row.deal_number ?? null,
    supersededById: row.superseded_by_id ?? null,
    updatedAt: row.updated_at_generation ?? null,
    view,
    state,
    recheck: classifyWeeklyReportArtifact(state),
  };
}

/**
 * How long the upload of a finished PDF may take before the single-flight entry is freed.
 *
 * ITS OWN budget rather than whatever a shared render/upload deadline had left. The flat 90 s that covered
 * both was shorter than a large report's render legitimately needs (see weeklyReportRenderTimeoutMs), so
 * the outer deadline would have cancelled a render that was about to succeed — and a render that used most
 * of a shared budget would leave the PUT with almost none. The point is not a tight SLA but that the entry
 * can never be held forever by one stalled R2 socket.
 */
export const WEEKLY_REPORT_UPLOAD_TIMEOUT_MS = 45_000;

const inFlightRenders = new Map<string, Promise<string>>();

/**
 * How long a render that ran out of time is remembered, so the next request is refused immediately.
 *
 * `/wr/:token/pdf` is anonymous, and a render that exceeds its deadline stores NOTHING — so without this,
 * every retry re-enters publishWeeklyReportPdf and pays the full budget again, downloading and transcoding
 * every photo up to the moment it is abandoned. One reader with a broken link and an impatient finger was
 * enough to keep a worker saturated indefinitely.
 *
 * Deliberately narrow: ONLY a deadline. Every other failure either fails fast (a corrupt original) or is
 * expected to succeed on the very next attempt (WEEKLY_REPORT_CONTENT_CHANGED, which means the report moved
 * and the retry must re-read it), and caching those would turn a self-healing hiccup into an outage.
 */
const WEEKLY_REPORT_RENDER_BACKOFF_MS = 60_000;

const renderDeadlineFailures = new Map<string, number>();

function recentRenderDeadlineFailure(key: string, now: number): boolean {
  const until = renderDeadlineFailures.get(key);
  if (until == null) return false;
  if (until > now) return true;
  renderDeadlineFailures.delete(key);
  return false;
}

/** Bounded sweep, so a process that renders many reports cannot accumulate expired entries forever. */
function rememberRenderDeadlineFailure(key: string, now: number): void {
  for (const [entry, until] of renderDeadlineFailures) {
    if (until <= now) renderDeadlineFailures.delete(entry);
  }
  renderDeadlineFailures.set(key, now + WEEKLY_REPORT_RENDER_BACKOFF_MS);
}

/** Test seam: the backoff is process-local state and would otherwise leak between cases. */
export function resetWeeklyReportRenderBackoff(): void {
  renderDeadlineFailures.clear();
}

/**
 * Process-local single flight, keyed on the exact artifact identity being produced.
 *
 * A PM clicking Download twice, or the client link and the CRM asking at once, would otherwise each
 * download and transcode every photo. The content-addressed key and the publication CAS remain the
 * CROSS-instance safety boundary; this only avoids paying for the same work twice inside one process.
 *
 * Exported for test: it is the only thing standing between an unauthenticated `/wr/:token/pdf` and one
 * full render per request, and its failure mode — a rejected promise cached forever — is invisible until
 * every subsequent download of that report fails too.
 */
export function coalesceWeeklyReportRender(key: string, factory: () => Promise<string>): Promise<string> {
  const existing = inFlightRenders.get(key);
  if (existing) return existing;
  const pending = factory();
  inFlightRenders.set(key, pending);
  const clear = () => {
    if (inFlightRenders.get(key) === pending) inFlightRenders.delete(key);
  };
  pending.then(clear, clear);
  return pending;
}

/**
 * The canonical text for a generation, or the literal "none" for a report with none.
 *
 * "none" only ever reaches the coalescer key: `weekly_reports.updated_at` is NOT NULL and the loader has
 * already found the row, so a null generation here would mean a row that does not exist.
 */
function generationToken(value: Date | string | null): string {
  return weeklyReportGeneration(value) ?? "none";
}

/**
 * The identity of the artifact a render is producing — what the single flight and the deadline backoff key
 * on. Everything that changes the document is in it, and nothing that does not.
 *
 * The THIRD use of a content generation, and the one with no database behind it to catch a mistake. Two
 * requests either side of an edit must land on different keys or the second joins the first's in-flight
 * render and is handed a key for a document it did not ask for. Exported so that is actually asserted: when
 * the generation was rounded to the millisecond, an edit and the render that preceded it produced the SAME
 * key, and the collision was invisible from either the row or the object store.
 */
export function weeklyReportRenderCoalescerKey(officeSlug: string, source: WeeklyReportPdfSource): string {
  const contentGeneration = generationToken(weeklyReportContentGeneration(source.state));
  const rendering = source.state.superseded ? "superseded" : "current";
  return `${officeSlug}:${source.reportId}:${CURRENT_WEEKLY_REPORT_PDF_RENDER_VERSION}:${contentGeneration}:${rendering}`;
}

/**
 * Point the report row at a freshly stored artifact, atomically, and return the key that is authoritative
 * afterwards — which is not necessarily the one just uploaded.
 *
 * Split out from the render/upload so it can be exercised against a real database. The three outcomes it
 * decides between are the whole safety argument for content-addressed artifacts, and a helper that only
 * ever runs behind an R2 upload is a helper nothing tests.
 */
export async function publishWeeklyReportPdfKey(
  client: QueryExecutor,
  input: {
    reportId: string;
    r2Key: string;
    bucket: string;
    /** `weekly_reports.updated_at` as the render read it, as canonical microsecond text. */
    generation: string;
    /** The WIDENED generation as the render read it — what the bytes actually represent. Same form. */
    contentGeneration: string;
  },
): Promise<string> {
  // The publication CAS, on three conditions and one recorded fact.
  //
  //   • updated_at unmoved — a report edited during the render never gets a pointer to a PDF of its
  //     previous content.
  //   • pdf_render_version <= ours — an older instance finishing late cannot walk the row backwards.
  //   • pdf_content_generation <= ours — NEITHER CAN AN OLDER RENDER. Two renders of different content
  //     produce different keys and take different coalescer entries, so without this the slower one wins
  //     whatever it rendered, and then reads as current because it also stamped the clock.
  //
  // pdf_content_generation is written as the generation the render READ, not as now(): it is the value the
  // staleness comparison reads back, and a clock reading taken after the render covers changes the bytes do
  // not contain. pdf_generated_at is still stamped, purely as the "when were these bytes made" record.
  // updated_at is deliberately untouched — bumping it here would make every render look like an edit.
  //
  // Both comparisons are at FULL microsecond precision, matching the reads. An earlier revision truncated
  // each side to milliseconds so a Date-parsed parameter could match — which made a report edited less than
  // a millisecond after the render read it compare EQUAL, so the CAS matched and published a PDF of the
  // previous content. The parameters now carry every digit Postgres stored (weeklyReportGenerationSql), so
  // `= $5` and `<= $6` are exact and a truncation would only reintroduce the collision.
  const published = await client.query(
    `UPDATE weekly_reports
        SET pdf_r2_key = $1,
            pdf_r2_bucket = $2,
            pdf_generated_at = now(),
            pdf_content_generation = $6::timestamptz,
            pdf_render_version = $3
      WHERE id = $4::uuid
        AND is_active
        AND updated_at = $5::timestamptz
        AND pdf_render_version <= $3
        AND (pdf_content_generation IS NULL
             OR pdf_content_generation <= $6::timestamptz)
      RETURNING pdf_r2_key`,
    [
      input.r2Key,
      input.bucket,
      CURRENT_WEEKLY_REPORT_PDF_RENDER_VERSION,
      input.reportId,
      input.generation,
      input.contentGeneration,
    ],
  );

  // Whether or not the CAS matched, the ROW now decides what may be handed back, and it is asked through
  // the same loader every other read uses. Re-deriving the answer here — "did updated_at move?" — is what
  // let the live inputs slip through before: the report row is only part of the generation, and a second
  // opinion about it is a second predicate to keep in step with the first. classifyWeeklyReportArtifact
  // already knows the whole rule.
  const after = await loadWeeklyReportPdfSource(client, input.reportId);
  if (!after) throw new AppError(404, "Weekly report not found");
  if (after.recheck === "awaiting-newer-renderer") {
    throw new AppError(
      503,
      "This report's PDF is being upgraded. Please try again in a moment.",
      "WEEKLY_REPORT_PDF_AWAITING_RENDERER",
    );
  }
  // Current: either the bytes just published, or a newer renderer's artifact that is authoritative and safe
  // to serve. Stale: something the render did not see has moved — including a live input that changed while
  // it ran, which the CAS above cannot lock. The row now carries an honest generation either way, so the
  // retry re-reads and renders the current content rather than being handed these bytes.
  if (after.recheck === "current" && after.state.pdfR2Key) return after.state.pdfR2Key;
  throw new AppError(
    503,
    "This report changed while its PDF was rendering. Please try the download again.",
    "WEEKLY_REPORT_CONTENT_CHANGED",
  );
}

/**
 * Render the PDF, store it under an immutable key, and point the row at it.
 *
 * MUST be called with no request transaction open — see the file header.
 *
 * No acting user is recorded. Publishing an artifact is bookkeeping the SERVER does, not something a person
 * did to the report, and attributing it would also mean the coalescer could not share one render between a
 * CRM download and a client opening their link at the same moment.
 */
export async function publishWeeklyReportPdf(
  officeSlug: string,
  source: WeeklyReportPdfSource,
  /**
   * Test seam, and the only one: `renderTimeoutMs` shortens the render budget so the deadline path can be
   * exercised at all. The real budget starts at twenty seconds and rises with the photo count, and
   * `AbortSignal.timeout` is not driven by the timers vitest can fake — so without this the branch that
   * refuses a repeat render, on the unauthenticated route where it matters, would have no coverage.
   */
  options: { renderTimeoutMs?: number } = {},
): Promise<string> {
  if (!isR2Configured()) {
    throw new AppError(503, "File storage is not configured, so the report PDF cannot be produced.");
  }
  // TWO generations, deliberately. The CAS can only be conditioned on the report row's own updated_at,
  // because that is the only row it locks; the COALESCER keys on everything the render actually reads, so a
  // request arriving after a header edit — or after a correction — does not join an in-flight render of the
  // document that preceded it and get handed the wrong key back.
  const generation = generationToken(source.updatedAt);
  const contentGeneration = generationToken(weeklyReportContentGeneration(source.state));
  const key = weeklyReportRenderCoalescerKey(officeSlug, source);
  // A render of THIS artifact ran out of time recently. Re-entering would pay the same budget again and
  // store nothing again — see WEEKLY_REPORT_RENDER_BACKOFF_MS.
  if (recentRenderDeadlineFailure(key, Date.now())) {
    throw new AppError(
      503,
      "This report's PDF is taking longer than expected to prepare. Please try again in a minute.",
      "WEEKLY_REPORT_PDF_RENDER_TIMED_OUT",
    );
  }
  return coalesceWeeklyReportRender(
    key,
    async () => {
      // Render FIRST, then derive the key from the bytes that were actually produced, so two instances
      // rendering different content can never collide on one object name.
      //
      // The cost of that, inherited from the scorecard artifact: a REGENERATION can land on a new key and
      // leave the previous object behind, with no path that deletes it. Pinning /CreationDate takes the
      // clock out of the document, but pdfkit's asynchronous PNG finalisation still renumbers objects
      // between runs (see WeeklyReportPdfData.creationDate). Bounded in practice — a sent report renders
      // once and its artifact then stays current — but it is not zero.
      // A deadline on the render AND one on the upload. Bounding only the render left the identical hang
      // one step later: an accepted-then-stalled PUT never settles, the promise stays in
      // `inFlightRenders`, and every later download for this generation on this process joins the same
      // permanent wait. They are separate signals rather than one shared budget so that the upload is not
      // charged for a render that legitimately took most of its allowance, and — the reason it matters
      // here — so the catch below can ask whether it was the RENDER that ran out.
      //
      // The render's is sized from the photos THEMSELVES — how many, and how many of them carry a mime
      // type whose decode the whole process takes in turn — because a render is all-or-nothing and a
      // report can carry sixty originals; see weeklyReportRenderTimeoutMs. When it DOES fire the failure
      // is remembered, so the next anonymous request is refused in microseconds instead of paying the
      // whole budget again.
      const renderTimeoutMs = options.renderTimeoutMs ?? weeklyReportRenderTimeoutMs(source.view.pdf.photos);
      const renderDeadline = AbortSignal.timeout(renderTimeoutMs);
      let pdf: Buffer;
      try {
        pdf = await renderWeeklyReportPdf(source.view.pdf, {
          signal: renderDeadline,
          timeoutMs: renderTimeoutMs,
        });
      } catch (error) {
        // Asked of the SIGNAL, not of the error's shape: the abort surfaces as whatever the aborted read,
        // transcode or stream happened to throw, and matching on those messages is a guess that rots.
        if (renderDeadline.aborted) {
          rememberRenderDeadlineFailure(key, Date.now());
          throw new AppError(
            503,
            "This report's PDF is taking longer than expected to prepare. Please try again in a minute.",
            "WEEKLY_REPORT_PDF_RENDER_TIMED_OUT",
          );
        }
        throw error;
      }
      const r2Key = weeklyReportPdfR2Key(
        officeSlug,
        source.dealNumber,
        source.dealId,
        source.reportId,
        CURRENT_WEEKLY_REPORT_PDF_RENDER_VERSION,
        weeklyReportPdfDigest(pdf),
        source.state.superseded,
      );
      await putObject(r2Key, pdf, "application/pdf", {
        signal: AbortSignal.timeout(WEEKLY_REPORT_UPLOAD_TIMEOUT_MS),
      });

      return withWeeklyReportOfficeClient(officeSlug, {}, (client) =>
        publishWeeklyReportPdfKey(client, {
          reportId: source.reportId,
          r2Key,
          bucket: process.env.R2_BUCKET_NAME || "trock-crm-files",
          generation,
          // The generation the render READ, recorded as what these bytes represent. Not now(): the render
          // just spent seconds on photos, and anything that moved while it ran must stay visible.
          contentGeneration,
        }),
      );
    },
  );
}

/**
 * Turn a loaded source into a usable key, rendering first when the stored artifact is missing or stale.
 *
 * Shared by the CRM download and the client's link so the "future renderer" case is handled once: this
 * instance can neither serve that artifact honestly nor replace it, and a 503 lets the retry land on an
 * instance that can.
 */
export async function resolveArtifactKey(
  officeSlug: string,
  source: WeeklyReportPdfSource,
): Promise<string> {
  if (source.recheck === "awaiting-newer-renderer") {
    throw new AppError(
      503,
      "This report's PDF is being upgraded. Please try again in a moment.",
      "WEEKLY_REPORT_PDF_AWAITING_RENDERER",
    );
  }
  if (source.recheck === "current" && source.state.pdfR2Key) return source.state.pdfR2Key;
  return publishWeeklyReportPdf(officeSlug, source);
}

/**
 * The download filename a client sees. Built from the property name and the week, ASCII-folded, because
 * "Cedar Springs — Weekly Report 2026-08-13.pdf" is what belongs in their downloads folder and the internal
 * report uuid is not.
 */
export function weeklyReportPdfFilename(view: WeeklyReportView): string {
  const property = view.pdf.propertyName
    .replace(/[^\x20-\x7e]/g, " ")
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return `${property || "Weekly Report"} - Weekly Report ${view.weekOf}.pdf`;
}

export async function weeklyReportPdfDownloadUrl(r2Key: string, filename: string): Promise<string> {
  return generateDownloadUrl(r2Key, PDF_DOWNLOAD_EXPIRY_SECONDS, filename, "attachment");
}
