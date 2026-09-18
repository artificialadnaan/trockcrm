import type pg from "pg";

export const SERVICE_RFP_SUBMISSIONS_MIGRATION = "0245_service_rfp_submissions.sql";
export const SERVICE_RFP_HISTORY_INDEX = "job_queue_service_rfp_history_idx";

// Like 0188's existing job_queue indexes, build this outside the multi-statement migration file's
// implicit transaction. The plain IF NOT EXISTS declaration in 0245 then becomes a no-op on deploy.
export async function runServiceRfpHistoryIndexMigration(client: pg.Client): Promise<void> {
  const result = await client.query<{ is_valid: boolean }>(
    `SELECT i.indisvalid AS is_valid FROM pg_index i
       JOIN pg_class c ON c.oid = i.indexrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = $1`,
    [SERVICE_RFP_HISTORY_INDEX],
  );
  if (result.rows[0]?.is_valid === true) return;
  if (result.rows[0]?.is_valid === false) {
    // Interrupted concurrent builds leave invalid stubs that IF NOT EXISTS alone would preserve.
    await client.query(`DROP INDEX CONCURRENTLY IF EXISTS public.${SERVICE_RFP_HISTORY_INDEX}`);
  }
  await client.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${SERVICE_RFP_HISTORY_INDEX}
    ON public.job_queue (office_id, (payload->>'dealId'), created_at)
    WHERE job_type IN ('rfp_request_delivery', 'rfp_bidboard_create')
      AND (lower(COALESCE(payload->'body'->'deal'->>'projectType', '')) IN ('4', 'service')
        OR (COALESCE(payload->'body'->'deal'->>'projectType', '') = ''
          AND payload->'body'->'deal'->>'workflowRoute' = 'service'))`);
}

/** Serialize the online build and ledger publication across overlapping API deployments. */
export async function runServiceRfpSubmissionsMigration(client: pg.Client, migrationSql: string): Promise<boolean> {
  const lock = "trockcrm:migration:0245_service-rfp-submissions";
  await client.query("SELECT pg_advisory_lock(hashtext($1))", [lock]);
  try {
    const existing = await client.query("SELECT id FROM public._migrations WHERE name = $1", [SERVICE_RFP_SUBMISSIONS_MIGRATION]);
    if (existing.rows.length) return false;
    await runServiceRfpHistoryIndexMigration(client);
    await client.query(migrationSql);
    await client.query("INSERT INTO public._migrations (name) VALUES ($1)", [SERVICE_RFP_SUBMISSIONS_MIGRATION]);
    return true;
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext($1))", [lock]);
  }
}
