import { and, eq, inArray, sql } from "drizzle-orm";
import { files } from "@trock-crm/shared/schema";
import type { UserRole } from "@trock-crm/shared/types";
import { pool } from "../../db.js";
import { FIELD_APP_ALLOWED_ROLE_SET } from "./field-app-roles.js";
// The lightweight module, not auth/service.js: this file is dynamic-imported by the worker, and reaching
// through the session layer would drag jsonwebtoken and the local-auth gate along for one office check.
import { getOfficeAccess } from "../auth/office-access.js";
import { deleteObject } from "../../lib/r2-client.js";
import { buildDealPhotoTimelineConditions } from "../files/photo-timeline-filters.js";
import { getFieldOfficeById, isFieldCrossOfficeWritesEnabled, runInOfficeTransaction } from "./cross-office.js";
import { assertActiveFieldProject } from "./projects-service.js";
import { MAX_RENDER_DEADLINE_MS } from "./ai-report-limits.js";
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
  isSoleLiveDeliveryForRun,
  markAiReportRunSucceeded,
  touchAiReportRunLease,
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
    is_active: boolean;
  }>(
    `SELECT id, role, display_name, first_name, last_name, email, is_active FROM public.users WHERE id = $1::uuid`,
    [userId],
  );
  const row = result.rows[0];
  if (!row) throw new AiReportError("The user who requested this report no longer exists.", false);
  // Re-apply the field-app gate, not just "the row exists". requireFieldContractor ran at ENQUEUE time, and
  // a run can sit behind the serial poller for minutes — long enough for an admin to deactivate the account.
  // Nothing later restores that check (assertActiveFieldProject validates the PROJECT, not the actor), so
  // without this the worker would spend on the model and file a report as a deactivated account. Not
  // retryable: a revocation does not resolve itself.
  //
  // Deactivation is the reachable path today — USER_ROLES and FIELD_APP_ALLOWED_ROLE_SET currently hold the
  // same members, so no assignable role fails the second test. It is checked anyway, both to stay correct
  // if that list ever narrows and because the column is not constrained to the current enum.
  if (!row.is_active || !FIELD_APP_ALLOWED_ROLE_SET.has(row.role)) {
    throw new AiReportError("The user who requested this report no longer has access to the field app.", false);
  }
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
  // externalThumbnailUrl with no r2Key) — a supported, ordinary row, but NOT one this feature can analyse:
  // reading it would mean outbound requests to addresses the server does not choose. It is passed through
  // and handled as unreadable by the vision pass, so it still prints with its own caption instead of
  // failing the whole report. Fetching them lives on feat/trockcam-external-photos.
  return ordered.map((row) => ({
    id: row.id,
    r2Key: row.r2Key,
    mimeType: row.mimeType,
    displayName: row.displayName,
    caption: row.caption,
  }));
}

/** Short bounded retry for a write whose failure is a bookkeeping problem, not a generation failure. */
async function withRetries<T>(operation: () => Promise<T>, attempts: number): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    }
  }
  throw lastError;
}

/**
 * Delete an uploaded report PDF that nothing references — and ONLY that.
 *
 * Phase E usually fails deterministically, before its insert: the project re-validation rejects and no row
 * was ever written. But a transaction can also reject AFTER its COMMIT is durable, when the connection drops
 * before the acknowledgement arrives. Deleting on that path would strip the object out from under a
 * committed `files` row and hand the user a report that 404s on download — strictly worse than the orphan
 * being cleaned up.
 *
 * So the key is only deleted once no row is found claiming it, and ANY uncertainty (including a failure of
 * the reconciliation query itself) leaves the object in place: an unreferenced object costs storage, a
 * missing one costs the report.
 */
async function discardUnreferencedReportPdf(
  office: Awaited<ReturnType<typeof getFieldOfficeById>>,
  userId: string,
  r2Key: string,
): Promise<{ committedFileId: string | null }> {
  try {
    const claimed = await runInOfficeTransaction(office, userId, async (db) => {
      const rows = await db.select({ id: files.id }).from(files).where(eq(files.r2Key, r2Key)).limit(1);
      return rows[0]?.id ?? null;
    });
    if (claimed) {
      // The COMMIT was durable and only its acknowledgement was lost, so Phase E threw over work that
      // actually landed. The id goes back to the caller rather than being logged and dropped: without it the
      // run is marked failed while the report sits, complete and downloadable, in the project's list —
      // which is precisely the state that invites the user to buy a second identical assessment.
      console.warn("[field-ai-report] Phase E reported a failure but the file row is committed; keeping the PDF", {
        r2Key,
        fileId: claimed,
      });
      return { committedFileId: claimed };
    }
    await deleteObject(r2Key);
  } catch (cleanupError) {
    console.error("[field-ai-report] could not reconcile an uploaded PDF; leaving it in place", {
      r2Key,
      error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
    });
  }
  return { committedFileId: null };
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
  let claimed = await markAiReportRunRunning(runId);
  if (!claimed && run.status !== "succeeded" && run.status !== "failed") {
    // Reconcile a claim whose OUTCOME is uncertain rather than deferring blindly.
    //
    // The claim UPDATE can commit while its acknowledgement is lost, so the handler throws over work that
    // actually landed. The queue redelivers, the run now reads 'running' with a lease stamped seconds ago,
    // and the guard above correctly refuses it — so this delivery defers, and keeps deferring, until the
    // lease goes stale twenty minutes later. Nothing generates in the meantime and the phone just waits out
    // the whole window before the foreground poll gives up.
    //
    // A run is claimed by exactly one delivery, so if no OTHER live delivery exists the row that set
    // 'running' can only have been this one. Re-read first: `run` was fetched before the claim attempt and
    // its status is stale by definition here.
    const current = await getAiReportRun(runId);
    if (current?.status === "running" && (await isSoleLiveDeliveryForRun(runId))) {
      console.warn("[field-ai-report] resuming a run this delivery had already claimed", { runId });
      claimed = true;
    }
  }
  if (!claimed) {
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
    // Re-apply the OFFICE authorization the ENQUEUE used — which is deliberately NOT the same rule in both
    // modes, so this has to follow the flag rather than always demanding a grant.
    //
    // Cross-office writes OFF: the write office is the uploader's ACTIVE office, and requireFieldContractor
    // authorized it through getOfficeAccess. That grant can be revoked (or the user moved to a different
    // primary office) while the run sits queued behind the serial poller, and nothing downstream re-checks
    // it — runInOfficeTransaction selects the schema, it does not authorize — so a revoked user would still
    // file a report into an office they can no longer write to.
    //
    // Cross-office writes ON: the write office is the DEAL's owning office, resolved from the database, and
    // no per-user grant was ever required. Demanding one here would reject runs the enqueue deliberately
    // accepted — and only after the user had already been told 202. The gate in that mode is the account
    // checks above plus assertActiveFieldProject, which runs at both ends of the job.
    //
    // Not retryable either way: a revocation does not undo itself.
    if (run.officeGrantRequired && !(await getOfficeAccess(requester.id, run.officeId)).hasAccess) {
      throw new AiReportError("You no longer have access to the office this report belongs to.", false);
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

    // Renew the lease before the last long phase. Phase B can legitimately eat most of the stale window on
    // a large report, and Phase D below is deliberately unbounded — without this a live run ages out
    // mid-render, the user's next enqueue reaps it, and they pay for a duplicate while this attempt is
    // still working.
    if (!(await touchAiReportRunLease(runId))) {
      // The row is no longer 'running': it was reaped (or otherwise finished) and a replacement may already
      // be in flight. Stop BEFORE rendering — otherwise this attempt uploads a PDF and commits a second
      // files row for a run the user was already told had failed.
      console.warn("[field-ai-report] lease lost before rendering — abandoning this attempt", {
        runId,
        // The model spend already happened and can no longer be written to the (terminal) row, so log it
        // rather than lose it entirely.
        costUsd: usage ? Number(usage.costUsd.toFixed(6)) : null,
      });
      return { claimed: true };
    }

    // ── Phase D: NO transaction — render the PDF and upload it ───────────────────────────────────
    // Same reasoning as Phase B. Rendering a 60-page report downloads and decodes every original and then
    // uploads the result: minutes of work, and none of it touches the database. Doing it inside the
    // transaction above would hold a pooled client idle-in-transaction for that whole time.
    // Bounded, for the same reason the assessment is — and it matters more here. This poller is dedicated
    // and single-in-flight, so a stalled object read or a decode that never settles does not just outlive
    // this run's lease, it wedges every subsequent AI report behind a handler nothing can free.
    const renderAbort = new AbortController();
    const renderExpiry = setTimeout(() => renderAbort.abort(), MAX_RENDER_DEADLINE_MS);
    let stored: Awaited<ReturnType<typeof renderAndStoreFieldPhotoReportPdf>>;
    try {
      stored = await renderAndStoreFieldPhotoReportPdf(prepared, office.slug, renderAbort.signal);
    } catch (error) {
      if (renderAbort.signal.aborted) {
        throw new AiReportError("The report took too long to render and was stopped. Try again with fewer photos.", false);
      }
      throw error;
    } finally {
      clearTimeout(renderExpiry);
    }

    // ── Phase E: short transaction — record the file row ─────────────────────────────────────────
    let recorded: Awaited<ReturnType<typeof recordFieldPhotoReportFile>>;
    try {
      // Do we still own this run? The lease was renewed before Phase D, but rendering is unbounded and can
      // outlast even a fresh window — at which point the requester's next enqueue reaps this run and starts
      // a replacement. Publishing anyway would commit the file while the guarded success write silently
      // matched zero rows: the phone shows 'failed' next to a report that exists, and the replacement bills
      // a second assessment for it. Checked BEFORE the insert so the catch below discards the upload.
      if (!(await touchAiReportRunLease(runId))) {
        throw new AiReportError("This report was superseded before it finished. Please try again.", false);
      }
      // Re-resolve the OFFICE as well. Everything from Phase A on uses the office object cached before the
      // render, and an office deactivated during those minutes would still be written to — leaving a run
      // marked 'succeeded' whose report the status endpoint refuses to hand back, because it resolves the
      // office through this same function and that requires is_active. Exactly the never-openable success
      // the project re-check below exists to prevent. This narrows a minutes-long window to the gap between
      // here and the commit; closing that last sliver would mean locking a public row inside an
      // office-scoped transaction, which is not worth the coupling.
      await getFieldOfficeById(run.officeId);
      // Re-resolve the REQUESTER too, on exactly the terms Phase A used. Everything from Phase A on runs as
      // the account cached before the render, and the publish below inserts the `files` row AS that user —
      // so an account deactivated, or a role moved outside the field-app set, during those minutes would
      // still get a report written under its name. The lease, office, project and photo re-checks all
      // guarded the report's SUBJECT; this guards its AUTHOR, which was the one input never revisited.
      await loadRequester(run.requestedBy);
      // ...and the office grant on the same terms as the enqueue: gated on the flag, so a cross-office run
      // the enqueue accepted is not rejected here for a grant it never required.
      if (run.officeGrantRequired && !(await getOfficeAccess(run.requestedBy, run.officeId)).hasAccess) {
        throw new AiReportError("You no longer have access to the office this report belongs to.", false);
      }
      recorded = await runInOfficeTransaction(office, requester.id, async (db) => {
        // Re-check the project. Phase D can run for minutes, and a project archived or moved to an excluded
        // stage in that window would otherwise be recorded against anyway — leaving a run marked 'succeeded'
        // whose report the status endpoint refuses to hand back (it re-runs the same assertion), i.e. a
        // success the user can never open.
        await assertActiveFieldProject(db, access, run.dealId);
        // Re-check the PHOTOS on the same terms. Deletion is soft — the row is marked inactive and its R2
        // object stays readable — so a photo removed during the long Phase D render is still embedded in the
        // PDF that was just uploaded. Publishing it would put a photograph the user deleted into a brand-new
        // downloadable report. Same predicate as Phase A, so "still in scope" means the same thing at both
        // ends of the run; it throws if any selected photo no longer qualifies, and the catch below discards
        // the PDF. Re-rendering without it is not an option at this point — the pages are already written.
        await loadPhotosForAssessment(db, run.dealId, run.photoIds);
        return recordFieldPhotoReportFile(db, access, prepared, stored);
      });
    } catch (error) {
      // The PDF is uploaded but probably nothing references it. recordFieldPhotoReportFile cleans up after
      // its OWN insert failure; this covers the re-validation above, which throws BEFORE the insert is ever
      // reached — without it every project archived mid-render leaves an orphaned object in the bucket.
      const { committedFileId } = await discardUnreferencedReportPdf(office, requester.id, stored.r2Key);
      // ...unless the reconciliation found the row. Then the transaction COMMITTED and only its
      // acknowledgement was lost, so this is a successful run that merely threw on the way out. Rethrowing
      // would mark it failed over a report the user can already open. Carry on down the success path.
      if (!committedFileId) throw error;
      console.warn("[field-ai-report] Phase E threw after a durable commit; continuing as a success", {
        runId,
        fileId: committedFileId,
      });
      recorded = { report: { id: committedFileId } } as typeof recorded;
    }
    const { report } = recorded;

    // From here the PDF EXISTS — it is committed to `files` and uploaded to R2, and it is already visible in
    // the project's report list. A failure to write the terminal ledger row is a bookkeeping problem, not a
    // generation failure, and must never be reported to the phone as "your report failed": the user would
    // pay for a second identical run while a perfectly good one sits in the list. Recorded separately from
    // the generation try/catch for exactly that reason.
    try {
      // Retried before giving up. Swallowing the first transient error left the run 'running' over a report
      // that EXISTS: both mobile watchers only refetch once they see 'succeeded', so they time out having
      // never shown it, and the stale sweep later marks a completed run failed and clears the way for a
      // duplicate paid assessment. A few short retries turn the common blip into a non-event.
      //
      // Not a durability guarantee — that would need an outbox the queue could re-drive, which is a bigger
      // change than this PR should carry. What it does is shrink the window, and the fallback below is
      // unchanged: never report a failure for a report the user can already open.
      await withRetries(() => markAiReportRunSucceeded(runId, report.id, usage), 3);
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
    console.error("[field-ai-report] report failed", { runId, error: message });
    try {
      // RETRIED, on the same terms as the success path. The fallback below is a genuine backstop but a poor
      // primary: expireStaleAiReportRuns only runs on this user's NEXT enqueue, so a single transient blip
      // here leaves the phone polling a 'running' row that will never resolve on its own, holding the
      // project and quota slots until the user happens to start another report. Three attempts turn "the
      // status write blipped" back into a non-event.
      await withRetries(() => markAiReportRunFailed(runId, userFacing, usage), 3);
    } catch (ledgerError) {
      // Guarded for the same reason the success path is, and it matters MORE here. Letting a transient
      // database error escape this catch would hand the queue a throw, and the run row is still 'running':
      // the redelivery cannot claim it and is deferred until the 20-minute lease expires, at which point the
      // whole assessment re-runs — paying for the model a second time purely because a status write blipped.
      //
      // Left 'running' instead. expireStaleAiReportRuns is the reconciler: it fails the row on this user's
      // next enqueue (or after the lease elapses) with its own abandoned-run message, so the phone still
      // reaches a terminal state and the in-flight slot still frees, without regenerating anything.
      console.error("[field-ai-report] report FAILED but the run row could not be updated", {
        runId,
        error: ledgerError instanceof Error ? ledgerError.message : String(ledgerError),
      });
    }
    // Swallowed on purpose: the run row carries the terminal failure the phone polls for, so re-throwing
    // would only make job_queue retry a run that is already reported as failed (and re-spend on the model).
    return { claimed: true };
  }
}
