import { sql } from "drizzle-orm";
import { pool } from "../../db.js";
import type { FieldTenantDb } from "./cross-office.js";
import type { AiReportUsage } from "./ai-report-service.js";

/**
 * Reads/writes for public.field_ai_report_runs — the status row the phone polls while an AI report is being
 * authored (migration 0208).
 *
 * Deliberately raw SQL on the shared pool rather than an office-scoped drizzle handle: the table is PUBLIC,
 * and the whole point of it living there is that the status endpoint can resolve a run id to its office
 * WITHOUT already knowing the office. Going through a tenant-scoped connection would reintroduce exactly
 * the chicken-and-egg this table exists to avoid.
 */

/**
 * job_queue.job_type for an AI report. Declared HERE rather than in ai-report-job.ts so the API route can
 * enqueue without importing the orchestrator (and with it sharp, pdfkit and the whole render path).
 */
export const AI_REPORT_JOB_TYPE = "ai_report_generation";

export type AiReportRunStatus = "queued" | "running" | "succeeded" | "failed";

export type AiReportRun = {
  id: string;
  dealId: string;
  officeId: string;
  officeSlug: string;
  requestedBy: string;
  photoIds: string[];
  reportTitle: string | null;
  focusPrompt: string | null;
  status: AiReportRunStatus;
  fileId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

type RunRow = {
  id: string;
  deal_id: string;
  office_id: string;
  office_slug: string;
  requested_by: string;
  photo_ids: string[];
  report_title: string | null;
  focus_prompt: string | null;
  status: AiReportRunStatus;
  file_id: string | null;
  error: string | null;
  created_at: Date;
  updated_at: Date;
};

function toRun(row: RunRow): AiReportRun {
  return {
    id: row.id,
    dealId: row.deal_id,
    officeId: row.office_id,
    officeSlug: row.office_slug,
    requestedBy: row.requested_by,
    photoIds: Array.isArray(row.photo_ids) ? row.photo_ids : [],
    reportTitle: row.report_title,
    focusPrompt: row.focus_prompt,
    status: row.status,
    fileId: row.file_id,
    error: row.error,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export type NewAiReportRun = {
  dealId: string;
  officeId: string;
  officeSlug: string;
  requestedBy: string;
  photoIds: string[];
  reportTitle: string | null;
  focusPrompt: string | null;
};

/**
 * Insert the run row on the CALLER'S transaction (an office-scoped connection; `public.` is qualified
 * explicitly so the office search_path is irrelevant).
 *
 * On the transaction rather than the shared pool on purpose: the route enqueues the job_queue row in the
 * same transaction, and the two must commit together. Split across connections, a rollback after the run
 * row landed would leave a 'queued' row no worker will ever pick up — the phone would poll it forever.
 */
export async function insertAiReportRunTx(db: FieldTenantDb, input: NewAiReportRun): Promise<AiReportRun> {
  // photoIds MUST go through sql.param(). A bare array interpolated into a drizzle template is expanded as
  // a value LIST — `($1, $2)::uuid[]` — which is not valid array syntax and fails EVERY insert with a
  // syntax error. sql.param binds the whole array as one parameter. Pinned by a real-SQL runtime test
  // (field-ai-report-runs.runtime.test.ts) rather than a mock, because a mocked insert cannot catch this.
  const result = await db.execute<RunRow>(sql`
    INSERT INTO public.field_ai_report_runs
      (deal_id, office_id, office_slug, requested_by, photo_ids, report_title, focus_prompt, status)
    VALUES (
      ${input.dealId}::uuid,
      ${input.officeId}::uuid,
      ${input.officeSlug},
      ${input.requestedBy}::uuid,
      ${sql.param(input.photoIds)}::uuid[],
      ${input.reportTitle},
      ${input.focusPrompt},
      'queued'
    )
    RETURNING *
  `);
  const row = (result as unknown as { rows: RunRow[] }).rows[0];
  if (!row) throw new Error("Failed to create the AI report run.");
  return toRun(row);
}

/**
 * How long a run may sit in queued/running before it is considered abandoned.
 *
 * This exists because of the in-flight unique index: without a way out, a run orphaned by a worker that
 * died mid-flight would occupy that (deal, requester) slot FOREVER and permanently lock the user out of AI
 * reports on that project. Generous on purpose — a 60-photo run that exhausts its retries can legitimately
 * run ~10 minutes — so this only ever fires on a genuinely dead run.
 */
const STALE_RUN_MINUTES = 20;

/**
 * Fail any abandoned run holding this user's in-flight slot for this project, and report how many were
 * cleared. Called before enqueueing, so the lockout is self-healing on the user's next attempt rather than
 * needing an operator.
 */
export async function expireStaleAiReportRuns(dealId: string, requestedBy: string): Promise<number> {
  const result = await pool.query(
    `UPDATE public.field_ai_report_runs
        SET status = 'failed',
            error = 'This report was abandoned before it finished. Please try again.',
            finished_at = now(),
            updated_at = now()
      WHERE deal_id = $1::uuid
        AND requested_by = $2::uuid
        AND status IN ('queued', 'running')
        AND created_at < now() - ($3 || ' minutes')::interval`,
    [dealId, requestedBy, String(STALE_RUN_MINUTES)],
  );
  return result.rowCount ?? 0;
}

/**
 * Postgres unique_violation raised by field_ai_report_runs_inflight_uidx on a double-tap.
 *
 * Walks the `cause` chain rather than inspecting only the top-level error: the insert goes through
 * drizzle's `.execute()`, which wraps driver errors (DrizzleQueryError carries the pg error as `cause`), and
 * a top-level-only check would silently never match — turning the double-tap path into dead code that 500s
 * instead. Matching on BOTH the SQLSTATE and the constraint name keeps it from swallowing any other
 * unique violation on this table.
 */
export function isInFlightRunConflict(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current && depth < 5; depth += 1) {
    const candidate = current as { code?: string; constraint?: string; cause?: unknown };
    if (
      candidate.code === "23505" &&
      String(candidate.constraint ?? "").includes("field_ai_report_runs_inflight")
    ) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

/**
 * How many AI reports one user may have in flight ACROSS ALL projects.
 *
 * The unique index bounds concurrency per (project, requester) only, and assertActiveFieldProject
 * deliberately lets a field user reach any active project — so without this, one account could enqueue a
 * 60-photo paid run for every project in the office back to back, and monopolise the serial AI-report
 * poller while doing it. /api/field carries no apiLimiter, so this endpoint has to bound itself.
 */
export const MAX_IN_FLIGHT_RUNS_PER_USER = 3;

/** In-flight runs for this user across every project. */
export async function countInFlightAiReportRunsForUser(requestedBy: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM public.field_ai_report_runs
      WHERE requested_by = $1::uuid AND status IN ('queued', 'running')`,
    [requestedBy],
  );
  return Number(result.rows[0]?.count ?? 0);
}

/**
 * The run already in flight for this (project, requester), if any. Only called after the unique index has
 * rejected an insert, to hand the caller back the run that won rather than an error.
 */
export async function getInFlightAiReportRun(dealId: string, requestedBy: string): Promise<AiReportRun | null> {
  const result = await pool.query<RunRow>(
    `SELECT * FROM public.field_ai_report_runs
      WHERE deal_id = $1::uuid AND requested_by = $2::uuid AND status IN ('queued', 'running')
      ORDER BY created_at DESC
      LIMIT 1`,
    [dealId, requestedBy],
  );
  return result.rows[0] ? toRun(result.rows[0]) : null;
}

export async function getAiReportRun(runId: string): Promise<AiReportRun | null> {
  const result = await pool.query<RunRow>(`SELECT * FROM public.field_ai_report_runs WHERE id = $1::uuid`, [runId]);
  return result.rows[0] ? toRun(result.rows[0]) : null;
}

/**
 * Claim the run for processing. Returns false when the row is not in a claimable state — which is how a
 * duplicate job delivery (two pollers, or a redelivery while the first attempt is still live) is stopped
 * from paying for a second Claude pass and writing a second PDF.
 *
 * A 'running' row is re-claimable once it is stale. This is NOT redundant with the enqueue-time reaper: on a
 * worker restart, recoverStaleJobs flips the job_queue row back to 'pending' and it is redelivered — but the
 * run row was already stamped 'running' by the dead attempt. Claiming only 'queued' would make that
 * redelivery a permanent no-op, stranding the run until a human noticed. The staleness bound is what keeps
 * this from stealing a run that is merely slow.
 */
export async function markAiReportRunRunning(runId: string): Promise<boolean> {
  const result = await pool.query(
    `UPDATE public.field_ai_report_runs
        SET status = 'running', started_at = now(), updated_at = now()
      WHERE id = $1::uuid
        AND (
          status = 'queued'
          OR (status = 'running' AND started_at < now() - ($2 || ' minutes')::interval)
        )`,
    [runId, String(STALE_RUN_MINUTES)],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Terminal writes are guarded on `status = 'running'`.
 *
 * Without the guard a run the stale sweep already failed could be resurrected by the very worker that
 * abandoned it — arriving late, overwriting 'failed' with 'succeeded' after the user has already started
 * (and paid for) a replacement. The guard makes the first terminal state win.
 */
export async function markAiReportRunSucceeded(
  runId: string,
  fileId: string,
  usage: AiReportUsage | null,
): Promise<void> {
  await pool.query(
    `UPDATE public.field_ai_report_runs
        SET status = 'succeeded', file_id = $2::uuid, error = NULL, finished_at = now(), updated_at = now(),
            model = COALESCE($3, model), input_tokens = COALESCE($4, input_tokens),
            output_tokens = COALESCE($5, output_tokens), cost_usd = COALESCE($6, cost_usd)
      WHERE id = $1::uuid AND status = 'running'`,
    [runId, fileId, usage?.model ?? null, usage?.inputTokens ?? null, usage?.outputTokens ?? null, usage?.costUsd ?? null],
  );
}

export async function markAiReportRunFailed(
  runId: string,
  error: string,
  usage: AiReportUsage | null,
): Promise<void> {
  await pool.query(
    `UPDATE public.field_ai_report_runs
        SET status = 'failed', error = $2, finished_at = now(), updated_at = now(),
            model = COALESCE($3, model), input_tokens = COALESCE($4, input_tokens),
            output_tokens = COALESCE($5, output_tokens), cost_usd = COALESCE($6, cost_usd)
      WHERE id = $1::uuid AND status = 'running'`,
    // Usage is still recorded on failure: a run that dies rendering the PDF already spent the model tokens.
    [runId, error.slice(0, 1000), usage?.model ?? null, usage?.inputTokens ?? null, usage?.outputTokens ?? null, usage?.costUsd ?? null],
  );
}
