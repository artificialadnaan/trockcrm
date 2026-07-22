import type pg from "pg";

// Mirrors the audit-log / project-number index-migration pattern. Migration 0188 adds two indexes to the
// EXISTING public.job_queue table, which on prod carries accumulated job history. A plain CREATE INDEX runs
// inside the migration file's implicit transaction and holds a write-blocking SHARE lock for the whole build,
// stalling job enqueues + worker outcome writes; and CREATE INDEX CONCURRENTLY cannot run inside a
// transaction block. So the runner intercepts 0188 and builds these two CONCURRENTLY here FIRST (each as its
// own statement / implicit txn) — then the SQL file's plain `CREATE INDEX IF NOT EXISTS` is a no-op.
export const BID_BOARD_INGEST_MIGRATION = "0188_bid_board_ingestion_inbox.sql";

export const JOB_QUEUE_PROCESSING_INDEX = "job_queue_processing_type_started_idx";
export const JOB_QUEUE_BBI_ONE_LIVE_JOB_INDEX = "job_queue_bbi_one_live_job_idx";

interface JobQueueIndex {
  name: string;
  createSql: string;
}

// Kept in lockstep with the plain CREATE INDEX statements in 0188_bid_board_ingestion_inbox.sql (which no-op
// via IF NOT EXISTS once these have built the indexes CONCURRENTLY).
const INDEXES: JobQueueIndex[] = [
  {
    name: JOB_QUEUE_PROCESSING_INDEX,
    // Partial on the transient 'processing' rows so the stale-job sweep's (job_type, started_processing_at)
    // lookup doesn't seq-scan the whole durable queue as its history grows.
    createSql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${JOB_QUEUE_PROCESSING_INDEX}
      ON public.job_queue (job_type, started_processing_at)
      WHERE status = 'processing'`,
  },
  {
    name: JOB_QUEUE_BBI_ONE_LIVE_JOB_INDEX,
    // At most ONE live (pending/processing) bid_board_ingest job per inbox row (enforces single-flight under a
    // multi-worker deployment). bid_board_ingest is a brand-new job type, so there are zero existing rows to
    // conflict with when this unique index builds.
    createSql: `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ${JOB_QUEUE_BBI_ONE_LIVE_JOB_INDEX}
      ON public.job_queue ((payload->>'inboxId'))
      WHERE job_type = 'bid_board_ingest' AND status IN ('pending', 'processing')`,
  },
];

async function getIndexValidity(client: pg.Client, indexName: string): Promise<boolean | null> {
  const result = await client.query<{ is_valid: boolean }>(
    `SELECT i.indisvalid AS is_valid
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indexrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname = $1`,
    [indexName]
  );
  if (result.rows.length === 0) return null;
  return result.rows[0].is_valid;
}

export async function runBidBoardIngestIndexMigration(client: pg.Client): Promise<void> {
  for (const index of INDEXES) {
    const validity = await getIndexValidity(client, index.name);
    if (validity === false) {
      // A prior CREATE INDEX CONCURRENTLY was interrupted and left an INVALID stub; IF NOT EXISTS would keep
      // it, so drop it (also CONCURRENTLY, so this never blocks writes) before rebuilding.
      await client.query(`DROP INDEX CONCURRENTLY IF EXISTS public.${index.name}`);
    }
    await client.query(index.createSql);
  }
}
