import { WEEKLY_REPORT_VIEW_RETENTION_MONTHS } from "@trock-crm/shared/lib/weeklyReportViews";
import { pool } from "../db.js";
import { timedPoolClientQuery, type TimedPoolLike } from "../lib/timed-pool-query.js";

/**
 * FORGETTING, ON A SCHEDULE.
 *
 * `weekly_report_views` records who opened a client report — full IP, full user agent, referrer — so that
 * "you never sent us that report" can be answered with evidence. That is the whole point of keeping it,
 * and it is also exactly why it cannot be kept forever: an access log with no expiry is not a record, it
 * is an accumulating liability, and the people in it are the client's staff rather than ours.
 *
 * TWENTY-FOUR MONTHS, Adnaan's call. Long enough to outlive any dispute about a project that closed last
 * year; short enough that the table is not a decade of somebody's browsing. The number lives in shared
 * because the audit page needs it too — anything older than this boundary is missing BY DESIGN, and a
 * page that did not know that would report it as "nobody opened it".
 *
 * IN THE WORKER, NOT A MIGRATION. Retention is a recurring act, not a one-off schema change, and putting
 * it in a migration would delete once on deploy and never again.
 */
export { WEEKLY_REPORT_VIEW_RETENTION_MONTHS };

/**
 * Rows per statement. The delete is batched because the alternative is one statement holding a lock over
 * however much history has accumulated — on the first pass after this ships, potentially the entire
 * table. Batching keeps each transaction short and lets an ordinary deploy restart interrupt the sweep
 * without rolling back work already done; the next pass simply resumes from whatever is still old.
 */
const PURGE_BATCH_SIZE = 5_000;

/** Batches per pass. A ceiling, so one run cannot spin for hours if the backlog is enormous. */
const MAX_BATCHES_PER_RUN = 40;

/**
 * Per-statement deadline. Generous — a 5,000-row delete on an indexed column is fast, and the point is
 * not to police a slow query but to make sure a HUNG one lets go of its connection.
 */
const PURGE_QUERY_TIMEOUT_MS = 60_000;

export interface WeeklyReportViewPurgeResult {
  /** False when the table is not there yet — see the probe below. */
  ran: boolean;
  deleted: number;
  /** True when the batch ceiling stopped us with rows still older than the cutoff. */
  moreRemaining: boolean;
}

/**
 * MIGRATIONS DO NOT RUN ON THE WORKER — only the API container runs the runner — so between an API deploy
 * and a worker deploy, and in any environment where the worker is ahead, this table may not exist. Every
 * other weekly-report job probes for what it needs for the same reason. Without this the sweep throws
 * `relation does not exist` once a minute and buries anything else in the log.
 */
async function viewsTableExists(
  query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, any>[] }>,
): Promise<boolean> {
  const result = await query(`SELECT to_regclass('public.weekly_report_views') AS reg`);
  return result.rows[0]?.reg != null;
}

export async function runWeeklyReportViewPurge(
  deps: {
    query?: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, any>[]; rowCount?: number | null }>;
    logger?: Pick<Console, "log" | "warn" | "error">;
    retentionMonths?: number;
    /**
     * Overridable so a test can actually drive the loop round more than once. At the production 5,000 a
     * suite would have to seed 5,001 rows to prove the sweep continues past its first batch, so nobody
     * would, and a version that deleted one batch and returned would pass every test while leaving the
     * backlog behind for good.
     */
    batchSize?: number;
  } = {},
): Promise<WeeklyReportViewPurgeResult> {
  // BOUNDED, because the worker pool sets no statement timeout. A DELETE that Postgres accepts and then
  // stops answering would hold its slot for as long as the process lives, and a DAILY cron means each
  // stuck run strands another connection until jobs with nothing to do with weekly reports cannot get
  // one. The queue layer already reaches for this helper for the same reason; a scheduled bulk delete
  // is exactly the shape of statement that earns it. Caught by Codex.
  const query =
    deps.query ??
    ((text: string, params?: unknown[]) =>
      timedPoolClientQuery<{ rows: Record<string, any>[]; rowCount?: number | null }>(
        pool as unknown as TimedPoolLike,
        text,
        params as any[] | undefined,
        {
          timeoutMs: PURGE_QUERY_TIMEOUT_MS,
          timeoutError: () => new Error("weekly-report view purge query timed out"),
        },
      ));
  const logger = deps.logger ?? console;
  const retentionMonths = deps.retentionMonths ?? WEEKLY_REPORT_VIEW_RETENTION_MONTHS;
  const batchSize = deps.batchSize ?? PURGE_BATCH_SIZE;

  if (!(await viewsTableExists(query))) {
    logger.log("[weekly-report-view-purge] public.weekly_report_views does not exist yet — skipping.");
    return { ran: false, deleted: 0, moreRemaining: false };
  }

  let deleted = 0;
  let moreRemaining = false;

  for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch += 1) {
    // The cutoff is recomputed per batch off `now()` IN THE DATABASE rather than a timestamp built here.
    // One clock, and it is the same one that stamped `occurred_at` — a worker whose clock has drifted
    // must not get to decide what counts as two years old.
    //
    // `ctid` for the self-join because it is the physical row address and needs no index lookup to come
    // back to; the subquery walks `weekly_report_views_occurred_idx`, which exists for this and nothing
    // else.
    const result = await query(
      `DELETE FROM public.weekly_report_views
        WHERE ctid IN (
          SELECT ctid FROM public.weekly_report_views
           WHERE occurred_at < now() - ($1 || ' months')::interval
           ORDER BY occurred_at
           LIMIT $2
        )`,
      [String(retentionMonths), batchSize],
    );

    const removed = result.rowCount ?? 0;
    deleted += removed;
    if (removed < batchSize) break;
    if (batch === MAX_BATCHES_PER_RUN - 1) {
      // ASKED, not assumed. A final batch that came back full means the ceiling stopped us, not that
      // anything is necessarily left: a backlog of exactly MAX_BATCHES * batchSize is fully cleared by
      // the last pass, and reporting "more remain" about an empty backlog is a warning that never
      // clears and that nobody can act on. Bounded by LIMIT 1 — it stops at the first row.
      const leftover = await query(
        `SELECT 1 FROM public.weekly_report_views
          WHERE occurred_at < now() - ($1 || ' months')::interval
          LIMIT 1`,
        [String(retentionMonths)],
      );
      moreRemaining = leftover.rows.length > 0;
    }
  }

  if (deleted > 0) {
    logger.log(
      `[weekly-report-view-purge] removed ${deleted} view row(s) older than ${retentionMonths} months` +
        (moreRemaining ? " — batch ceiling reached, more remain for the next pass" : ""),
    );
  }

  return { ran: true, deleted, moreRemaining };
}
