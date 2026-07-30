import { and, eq, inArray, sql } from "drizzle-orm";
import { files } from "@trock-crm/shared/schema";
import type { UserRole } from "@trock-crm/shared/types";
import { pool } from "../../db.js";
import { buildDealPhotoTimelineConditions } from "../files/photo-timeline-filters.js";
import { getFieldOfficeById, runInOfficeTransaction } from "./cross-office.js";
import { assertActiveFieldProject } from "./projects-service.js";
import {
  prepareFieldPhotoReport,
  recordFieldPhotoReportFile,
  renderAndStoreFieldPhotoReportPdf,
} from "./photo-reports-service.js";
import {
  generateAiPhotoAssessment,
  serializeFinding,
  AiReportError,
  type AiReportDeps,
  type AiReportPhotoInput,
  type AiReportUsage,
} from "./ai-report-service.js";
import {
  AI_REPORT_JOB_TYPE,
  getAiReportRun,
  markAiReportRunFailed,
  markAiReportRunRunning,
  markAiReportRunSucceeded,
} from "./ai-report-runs.js";

export { AI_REPORT_JOB_TYPE };

/**
 * Orchestrates one AI report end to end. Lives in the SERVER (not the worker) because everything it needs —
 * sharp, pdfkit, the R2 client, the cross-office transaction envelope — is a server dependency; the worker
 * has none of them and reaches this through a dynamic import (the same shape procore-photos.ts uses for
 * the R2 client).
 *
 * The phase split is load-bearing, not stylistic. runInOfficeTransaction opens a pooled connection, sets
 * `SET LOCAL statement_timeout = '30s'` and holds it until its callback resolves. A 30-90 second Claude
 * vision pass inside that callback would pin a pool connection idle-in-transaction for the whole call — the
 * documented cause of the "Couldn't load deals" pool saturation. So:
 *
 *   Phase A (short transaction)  read the project + the photo rows
 *   Phase B (NO transaction)     the model call, the slow part
 *   Phase C (short transaction)  render + store the PDF
 */

/** job_queue payload. Intentionally just the run id — every other field is read from the run row, so the
 *  queued payload can never drift from the row the phone is polling. */
export type AiReportJobPayload = { runId: string };

const REPORT_SECTION_TITLE = "Photo Findings";

/**
 * How long to ask the queue to wait before redelivering a job whose run is held by a live attempt.
 * Comfortably inside the run's own stale window, so the retry lands soon after the run becomes reclaimable.
 */
const RECLAIM_RETRY_SECONDS = 5 * 60;

type Requester = { id: string; role: UserRole; displayName: string };

async function loadRequester(userId: string): Promise<Requester> {
  const result = await pool.query<{
    id: string;
    role: UserRole;
    display_name: string | null;
    first_name: string | null;
    last_name: string | null;
    email: string;
  }>(`SELECT id, role, display_name, first_name, last_name, email FROM public.users WHERE id = $1::uuid`, [userId]);
  const row = result.rows[0];
  if (!row) throw new AiReportError("The user who requested this report no longer exists.", false);
  const displayName =
    row.display_name?.trim() ||
    [row.first_name, row.last_name].filter(Boolean).join(" ").trim() ||
    row.email;
  return { id: row.id, role: row.role, displayName };
}

/**
 * Resolve the selected photos to their stored originals, in the caller's selection order, constrained to the
 * project's photo scope. Reuses buildDealPhotoTimelineConditions — the same predicate the PDF renderer uses —
 * so the AI can never be shown a photo the report itself would refuse to render.
 */
async function loadPhotosForAssessment(
  db: Parameters<Parameters<typeof runInOfficeTransaction>[2]>[0],
  dealId: string,
  photoIds: string[],
): Promise<AiReportPhotoInput[]> {
  const scope = await buildDealPhotoTimelineConditions(db, dealId, { includeDeleted: false });
  const rows = await db
    .select({
      id: files.id,
      displayName: files.displayName,
      r2Key: files.r2Key,
      mimeType: files.mimeType,
      // The crew's caption. Sent to the model as field context AND left in place on any photo the model
      // passes over, so a photo without AI findings still reads exactly as the field left it.
      caption: files.description,
    })
    .from(files)
    .where(and(inArray(files.id, photoIds), scope));

  const byId = new Map(rows.map((row) => [row.id, row]));
  const ordered = photoIds.map((id) => byId.get(id)).filter((row): row is NonNullable<typeof row> => Boolean(row));
  if (ordered.length !== photoIds.length) {
    throw new AiReportError("One or more selected photos are unavailable for this project.", false);
  }
  // A photo with no stored original is an external-only import (CompanyCam and similar keep externalUrl /
  // externalThumbnailUrl with no r2Key) — a supported, ordinary row. It is passed through and handled as
  // unreadable by the vision pass, so it still prints with its own caption instead of failing the whole
  // report the way an up-front rejection did.
  return ordered.map((row) => ({
    id: row.id,
    r2Key: row.r2Key,
    mimeType: row.mimeType,
    displayName: row.displayName,
    caption: row.caption,
  }));
}

/**
 * Run the job for `runId`. Terminal outcomes are written to the run row, so the phone always sees either a
 * pdf or a reason — never a silent hang.
 *
 * Returns `{ claimed: false }` when another delivery already took the run (job_queue can redeliver after a
 * worker dies mid-flight, and a second Claude pass costs real money and would produce a duplicate PDF).
 */
export async function runFieldAiReportJob(
  payload: AiReportJobPayload,
  deps: AiReportDeps = {},
): Promise<{ claimed: boolean; fileId?: string; retryAfterSeconds?: number }> {
  const runId = String(payload?.runId ?? "").trim();
  if (!runId) throw new Error("ai_report_generation payload is missing runId");

  const run = await getAiReportRun(runId);
  if (!run) throw new Error(`ai_report_generation run ${runId} not found`);
  if (!(await markAiReportRunRunning(runId))) {
    // Not claimable. Two very different reasons, and conflating them strands runs:
    //   * already terminal  → the work is done; let the queue complete this delivery.
    //   * still 'running'   → another attempt holds it and is not yet stale. recoverStaleJobs requeues the
    //     QUEUE row after 5 minutes while a run stays protected for 20, so simply returning here would let
    //     processJob mark the redelivered job COMPLETED and no worker would ever come back — the run sits in
    //     'running' until the sweep expires it and the user has to start over. Ask the queue to redeliver
    //     later instead, so the run is picked up the moment it becomes reclaimable.
    const terminal = run.status === "succeeded" || run.status === "failed";
    console.warn("[field-ai-report] run not claimable", { runId, status: run.status, terminal });
    return { claimed: false, retryAfterSeconds: terminal ? undefined : RECLAIM_RETRY_SECONDS };
  }

  let usage: AiReportUsage | null = null;
  try {
    const requester = await loadRequester(run.requestedBy);
    const office = await getFieldOfficeById(run.officeId);
    // office_slug on the row is a point-in-time record of the schema this run was enqueued against; the
    // live office is authoritative. They should never disagree — if they do, an office was renamed between
    // enqueue and execution, and every historical row for it now reads wrong. Cheap to notice, invisible
    // otherwise.
    if (office.slug !== run.officeSlug) {
      console.warn("[field-ai-report] office slug drifted since enqueue", {
        runId,
        enqueuedSlug: run.officeSlug,
        currentSlug: office.slug,
      });
    }
    const access = { userId: requester.id, userRole: requester.role };

    // ── Phase A: short transaction — project + photo rows ────────────────────────────────────────
    const { projectName, photos } = await runInOfficeTransaction(office, requester.id, async (db) => {
      const project = await assertActiveFieldProject(db, access, run.dealId);
      return {
        projectName: project.name,
        photos: await loadPhotosForAssessment(db, project.id, run.photoIds),
      };
    });

    // ── Phase B: NO transaction — the model call ─────────────────────────────────────────────────
    const assessment = await generateAiPhotoAssessment(
      { projectName, photos, focusPrompt: run.focusPrompt },
      deps,
    ).catch((error) => {
      // Batches that completed before the failure were still paid for — carry their spend onto the ledger.
      // Read off any error shape: a decode failure mid-run is a plain Error, not an AiReportError.
      const attached = (error as { usage?: AiReportUsage } | null)?.usage;
      if (attached) usage = attached;
      throw error;
    });
    usage = assessment.usage;

    const findingById = new Map(assessment.findings.map((finding) => [finding.photoId, finding]));

    // ── Phase C: short transaction — read what the renderer needs ────────────────────────────────
    const prepared = await runInOfficeTransaction(office, requester.id, (db) =>
      prepareFieldPhotoReport(db, access, {
        projectId: run.dealId,
        reportTitle: run.reportTitle?.trim() || `${projectName} Condition Assessment`,
        executiveSummary: assessment.executiveSummary,
        photoLayout: "findings",
        fileDescription: `AI condition assessment for ${projectName}`,
        coverData: {
          creatorName: requester.displayName,
          companyName: null,
          reportDateLabel: null,
          projectName,
        },
        sections: [
          {
            title: REPORT_SECTION_TITLE,
            photoIds: run.photoIds,
            // EVERY selected photo prints. Only the ones the model wrote about get an override; the rest
            // pass `null`, which makes generateFieldPhotoReport fall back to the photo's own stored caption
            // — so a photo with nothing in scope reads exactly as the field left it, rather than carrying
            // an invented "no issues found" line.
            photoOverrides: run.photoIds.map((photoId) => {
              const finding = findingById.get(photoId);
              return { id: photoId, description: finding ? serializeFinding(finding) : null };
            }),
          },
        ],
      }),
    );

    // ── Phase D: NO transaction — render the PDF and upload it ───────────────────────────────────
    // Same reasoning as Phase B. Rendering a 60-page report downloads and decodes every original and then
    // uploads the result: minutes of work, and none of it touches the database. Doing it inside the
    // transaction above would hold a pooled client idle-in-transaction for that whole time.
    const stored = await renderAndStoreFieldPhotoReportPdf(prepared, office.slug);

    // ── Phase E: short transaction — record the file row ─────────────────────────────────────────
    const { report } = await runInOfficeTransaction(office, requester.id, async (db) => {
      // Re-check the project. Phase D can run for minutes, and a project archived or moved to an excluded
      // stage in that window would otherwise be recorded against anyway — leaving a run marked 'succeeded'
      // whose report the status endpoint refuses to hand back (it re-runs the same assertion), i.e. a
      // success the user can never open.
      await assertActiveFieldProject(db, access, run.dealId);
      return recordFieldPhotoReportFile(db, access, prepared, stored);
    });

    // From here the PDF EXISTS — it is committed to `files` and uploaded to R2, and it is already visible in
    // the project's report list. A failure to write the terminal ledger row is a bookkeeping problem, not a
    // generation failure, and must never be reported to the phone as "your report failed": the user would
    // pay for a second identical run while a perfectly good one sits in the list. Recorded separately from
    // the generation try/catch for exactly that reason.
    try {
      await markAiReportRunSucceeded(runId, report.id, usage);
    } catch (ledgerError) {
      // Swallowed on purpose. Re-throwing would land in the catch below and mark the run FAILED — telling
      // the user their report failed while it sits, complete, in the project's report list, and inviting a
      // second paid run. Left 'running' instead: the phone eventually times out (and says the report will
      // appear when it finishes, which is true), the stale sweep tidies the row, and the PDF is unaffected.
      console.error("[field-ai-report] report SUCCEEDED but the run row could not be updated", {
        runId,
        fileId: report.id,
        error: ledgerError instanceof Error ? ledgerError.message : String(ledgerError),
      });
    }
    console.log("[field-ai-report] report generated", {
      runId,
      dealId: run.dealId,
      photoCount: photos.length,
      // Cited vs reviewed: the ratio to watch. All-cited on a focused run means the scope isn't biting.
      citedCount: assessment.findings.length,
      focused: Boolean(run.focusPrompt),
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUsd: Number(usage.costUsd.toFixed(6)),
    });
    return { claimed: true, fileId: report.id };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // The run row's `error` is shown verbatim in the app. AiReportError messages are written for that;
    // anything else is a driver/infrastructure error whose text can carry the full failing SQL and its bound
    // parameters (drizzle's DrizzleQueryError does exactly that), which must not reach a phone. Log the real
    // one, surface a generic line.
    const userFacing =
      error instanceof AiReportError
        ? message
        : "The report could not be generated. Please try again, or contact support if it keeps happening.";
    await markAiReportRunFailed(runId, userFacing, usage);
    console.error("[field-ai-report] report failed", { runId, error: message });
    // Swallowed on purpose: the run row carries the terminal failure the phone polls for, so re-throwing
    // would only make job_queue retry a run that is already reported as failed (and re-spend on the model).
    return { claimed: true };
  }
}
