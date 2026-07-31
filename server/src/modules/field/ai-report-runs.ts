import { sql } from "drizzle-orm";
import { pool } from "../../db.js";
import type { FieldTenantDb } from "./cross-office.js";
import type { AiReportUsage } from "./ai-report-service.js";
// Paired with the model-phase deadline ceiling — see ai-report-limits.ts for why they live together.
import { STALE_RUN_MINUTES } from "./ai-report-limits.js";

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
  // The per-user quota is enforced INSIDE this statement, not by a preceding SELECT: a count-then-insert
  // reads a pre-lock snapshot, so concurrent POSTs for DIFFERENT projects each see "under the limit" before
  // any of them commits, and the in-flight unique index only collides on the SAME (deal, requester) — a
  // parallel burst would walk straight through a JS check and queue an unbounded number of paid 60-photo
  // runs.
  //
  // Moving the predicate into the INSERT is necessary but NOT sufficient: under READ COMMITTED the
  // sub-select still reads a snapshot that excludes other transactions' uncommitted rows, so the same burst
  // across different projects still passes. The advisory lock is what actually serialises it. Transaction
  // scoped, so it releases on the caller's commit or rollback; keyed per requester, so two users never wait
  // on each other; namespaced, because the hashtext(bigint) key space is global to the database.
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`field-ai-report-quota:${input.requestedBy}`}))`);
  const result = await db.execute<RunRow>(sql`
    INSERT INTO public.field_ai_report_runs
      (deal_id, office_id, office_slug, requested_by, photo_ids, report_title, focus_prompt, status)
    SELECT
      ${input.dealId}::uuid,
      ${input.officeId}::uuid,
      ${input.officeSlug},
      ${input.requestedBy}::uuid,
      ${sql.param(input.photoIds)}::uuid[],
      ${input.reportTitle},
      ${input.focusPrompt},
      'queued'
    WHERE (
      SELECT count(*)
        FROM public.field_ai_report_runs
       WHERE requested_by = ${input.requestedBy}::uuid
         AND status IN ('queued', 'running')
    ) < ${MAX_IN_FLIGHT_RUNS_PER_USER}
    RETURNING *
  `);
  const row = (result as unknown as { rows: RunRow[] }).rows[0];
  // No row means the WHERE predicate rejected it — the user is at their quota.
  if (!row) throw new AiReportQuotaExceededError(MAX_IN_FLIGHT_RUNS_PER_USER);
  return toRun(row);
}


/**
 * Fail this user's abandoned runs ACROSS EVERY PROJECT, and report how many were cleared. Called before
 * enqueueing, so a lockout is self-healing on the user's next attempt rather than needing an operator.
 *
 * User-scoped, not project-scoped: the per-user concurrency quota counts runs on every project, so three
 * abandoned runs on OTHER projects would otherwise 429 the user forever — a project-scoped sweep can never
 * clear them, and they would have to revisit each original project just to unstick themselves.
 *
 * Staleness is measured from COALESCE(started_at, created_at), not created_at. The AI-report poller is
 * serial, so a run can legitimately sit queued for a long while and only start recently; measuring from
 * creation would expire a run that is actively mid-model-call, free its slot, and let a replacement be
 * queued while the original keeps spending. `started_at` is renewed at each long phase boundary
 * (touchAiReportRunLease), so this measures time since the last sign of progress rather than total runtime.
 */
export async function expireStaleAiReportRuns(requestedBy: string): Promise<number> {
  const result = await pool.query(
    `UPDATE public.field_ai_report_runs
        SET status = 'failed',
            error = 'This report was abandoned before it finished. Please try again.',
            finished_at = now(),
            updated_at = now()
      WHERE requested_by = $1::uuid
        AND status IN ('queued', 'running')
        AND COALESCE(started_at, created_at) < now() - ($2 || ' minutes')::interval`,
    [requestedBy, String(STALE_RUN_MINUTES)],
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

/** Raised when the INSERT is refused because the user is already at their concurrent-run quota. */
export class AiReportQuotaExceededError extends Error {
  constructor(readonly limit: number) {
    super(`Quota of ${limit} concurrent AI reports reached.`);
    this.name = "AiReportQuotaExceededError";
  }
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
 * Renew this run's lease, and report whether we still hold it.
 *
 * `started_at` doubles as the lease timestamp — it is what BOTH the enqueue-time reaper and the re-claim
 * guard above measure staleness from. Stamping it only at claim time bounds the whole job by
 * STALE_RUN_MINUTES, but only the model call is actually deadline-bounded: rendering and uploading a
 * 60-page PDF is deliberately unbounded, so a run that spends most of its model budget and then renders
 * slowly can cross the window while it is still very much alive. The next enqueue then fails it, frees the
 * in-flight slot, and queues a paid replacement — while the original carries on and commits a second PDF.
 *
 * Renewed at a PHASE BOUNDARY rather than on a timer, on purpose. A periodic heartbeat proves the event
 * loop is alive, not that the job is progressing, so a wedged run would hold its slot forever and the reaper
 * could never do its job. Renewing once per long phase gives that phase a full fresh window and no more.
 *
 * Returns false when the row is no longer 'running' — the run was already reaped (or finished) and a
 * replacement may be in flight. The caller MUST stop rather than spend on work whose result is unusable.
 */
export async function touchAiReportRunLease(runId: string): Promise<boolean> {
  const result = await pool.query(
    `UPDATE public.field_ai_report_runs
        SET started_at = now(), updated_at = now()
      WHERE id = $1::uuid AND status = 'running'`,
    [runId],
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
