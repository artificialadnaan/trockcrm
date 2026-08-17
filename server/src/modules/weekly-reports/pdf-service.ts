import { AppError } from "../../middleware/error-handler.js";
import { generateDownloadUrl, isR2Configured, putObject } from "../../lib/r2-client.js";
import { withWeeklyReportOfficeClient } from "./office-connection.js";
import {
  CURRENT_WEEKLY_REPORT_PDF_RENDER_VERSION,
  classifyWeeklyReportArtifact,
  weeklyReportPdfDigest,
  weeklyReportPdfR2Key,
  type WeeklyReportArtifactRecheck,
  type WeeklyReportPdfArtifactState,
} from "./pdf-artifact.js";
import { renderWeeklyReportPdf, type WeeklyReportPdfPhoto } from "./pdf.js";
import { buildWeeklyReportView, type WeeklyReportView } from "./report-view.js";
import type { QueryExecutor } from "./projects-service.js";

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
  /** The `updated_at` this data was read at — the value the publication CAS is conditioned on. */
  updatedAt: Date | string | null;
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
            d.name           AS deal_name,
            d.deal_number    AS deal_number,
            proj.property_display_name, proj.client_name,
            proj.client_doc_name, proj.client_pm_name, proj.client_rm_name, proj.client_cm_name,
            proj.trock_pm_user_id, proj.trock_super_user_id,
            proj.contract_date, proj.contract_date_note,
            proj.project_start_date, proj.project_start_date_note,
            proj.project_completion_date, proj.project_completion_date_note,
            proj.projected_duration_weeks AS project_projected_duration_weeks,
            pm.display_name  AS trock_pm_name,
            sup.display_name AS trock_super_name
       FROM weekly_reports wr
       JOIN deals d ON d.id = wr.deal_id
       LEFT JOIN weekly_report_projects proj ON proj.id = wr.weekly_report_project_id
       LEFT JOIN public.users pm  ON pm.id = proj.trock_pm_user_id
       LEFT JOIN public.users sup ON sup.id = proj.trock_super_user_id
      WHERE wr.id = $1::uuid AND wr.is_active
      LIMIT 1`,
    [reportId],
  );
  const row = result.rows[0];
  if (!row) return null;

  const view = buildWeeklyReportView({
    report: row,
    // The joined columns ARE the live setup row; `projected_duration_weeks` is aliased above because the
    // report carries a column of the same name and the report's value is the authoritative one.
    project: { ...row, projected_duration_weeks: row.project_projected_duration_weeks },
    dealName: row.deal_name,
    photos: await loadPhotos(client, reportId),
  });

  const state: WeeklyReportPdfArtifactState = {
    pdfR2Key: row.pdf_r2_key ?? null,
    pdfRenderVersion: Number(row.pdf_render_version ?? 0),
    pdfGeneratedAt: row.pdf_generated_at ?? null,
    updatedAt: row.updated_at ?? null,
    // Only a sent report has every input frozen — see WeeklyReportPdfArtifactState.contentFrozen.
    contentFrozen: row.status === "sent",
  };

  return {
    reportId,
    dealId: row.deal_id,
    dealNumber: row.deal_number ?? null,
    supersededById: row.superseded_by_id ?? null,
    updatedAt: row.updated_at ?? null,
    view,
    state,
    recheck: classifyWeeklyReportArtifact(state),
  };
}

const inFlightRenders = new Map<string, Promise<string>>();

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

function generationToken(updatedAt: Date | string | null): string {
  if (updatedAt == null) return "none";
  return updatedAt instanceof Date ? updatedAt.toISOString() : new Date(updatedAt).toISOString();
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
  input: { reportId: string; r2Key: string; bucket: string; generation: string },
): Promise<string> {
  // The publication CAS. Conditioned on updated_at not having moved since the read, so a report edited
  // during the render never gets a pointer to a PDF of its previous content; and on the render version, so
  // an older instance finishing late cannot walk the row backwards.
  //
  // pdf_generated_at is stamped and updated_at is deliberately NOT touched: updated_at is the content
  // generation this artifact is compared against, and bumping it here would make every render look like an
  // edit and re-render on the download after it, forever.
  const published = await client.query(
    `UPDATE weekly_reports
        SET pdf_r2_key = $1,
            pdf_r2_bucket = $2,
            pdf_generated_at = now(),
            pdf_render_version = $3
      WHERE id = $4::uuid
        AND is_active
        AND date_trunc('milliseconds', updated_at) = $5::timestamptz
        AND pdf_render_version <= $3
      RETURNING pdf_r2_key`,
    [input.r2Key, input.bucket, CURRENT_WEEKLY_REPORT_PDF_RENDER_VERSION, input.reportId, input.generation],
  );
  if (published.rows[0]?.pdf_r2_key) return published.rows[0].pdf_r2_key as string;

  // The CAS matched nothing. Either the content moved — the caller must re-read, because serving this
  // render would show the client a week that has since been corrected — or a newer renderer already owns
  // the row, whose artifact is authoritative and safe to hand back.
  const current = await client.query(
    `SELECT pdf_r2_key, updated_at FROM weekly_reports WHERE id = $1::uuid AND is_active LIMIT 1`,
    [input.reportId],
  );
  const row = current.rows[0];
  if (!row) throw new AppError(404, "Weekly report not found");
  if (generationToken(row.updated_at) !== input.generation || !row.pdf_r2_key) {
    throw new AppError(
      503,
      "This report changed while its PDF was rendering. Please try the download again.",
      "WEEKLY_REPORT_CONTENT_CHANGED",
    );
  }
  return row.pdf_r2_key as string;
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
): Promise<string> {
  if (!isR2Configured()) {
    throw new AppError(503, "File storage is not configured, so the report PDF cannot be produced.");
  }
  const generation = generationToken(source.updatedAt);
  return coalesceWeeklyReportRender(
    `${officeSlug}:${source.reportId}:${CURRENT_WEEKLY_REPORT_PDF_RENDER_VERSION}:${generation}`,
    async () => {
      // Render FIRST, then derive the key from the bytes that were actually produced, so two instances
      // rendering different content can never collide on one object name.
      //
      // The cost of that, inherited from the scorecard artifact: a REGENERATION can land on a new key and
      // leave the previous object behind, with no path that deletes it. Pinning /CreationDate takes the
      // clock out of the document, but pdfkit's asynchronous PNG finalisation still renumbers objects
      // between runs (see WeeklyReportPdfData.creationDate). Bounded in practice — a sent report renders
      // once and its artifact then stays current — but it is not zero.
      const pdf = await renderWeeklyReportPdf(source.view.pdf);
      const r2Key = weeklyReportPdfR2Key(
        officeSlug,
        source.dealNumber,
        source.dealId,
        source.reportId,
        CURRENT_WEEKLY_REPORT_PDF_RENDER_VERSION,
        weeklyReportPdfDigest(pdf),
      );
      await putObject(r2Key, pdf, "application/pdf");

      return withWeeklyReportOfficeClient(officeSlug, {}, (client) =>
        publishWeeklyReportPdfKey(client, {
          reportId: source.reportId,
          r2Key,
          bucket: process.env.R2_BUCKET_NAME || "trock-crm-files",
          generation,
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
