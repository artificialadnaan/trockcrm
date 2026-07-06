-- 0176_deals_rfp_bidboard_attempt_at.sql
-- Add a nullable `rfp_bidboard_attempt_at` to each tenant's `deals` table.
--
-- Per-ATTEMPT marker for a request-less (voting-path) Bid Board create. A request-less create (a 2/3-YES
-- vote decision, and each subsequent Retry) is fire-and-forget: the worker POSTs to SyncHub's create-from-rfp
-- and SyncHub reports the outcome LATER via a decoupled bid-board-created callback. That decoupling means a
-- late duplicate of a PRIOR attempt's 'failed' callback — or a PRIOR attempt's dead rfp_bidboard_create job —
-- can arrive after a Retry has already started a fresh attempt, and (with no per-attempt identity) flip that
-- fresh in-flight attempt back to send_failed. This column stamps the current attempt's start; the failed
-- callback (pending sub-case) and the dead-letter sweep compare the callback's / job's timestamp against it and
-- ignore anything older than the current attempt. Stamped by /rfp-retry (each retry supersedes the prior one);
-- NULL for the first attempt (which stays exempt, preserving its immediate surfacing) and cleared on a
-- successful link + on Return-to-Opportunity. The override-approve sub-case keeps using rfp_override_reviewed_at.
--
-- Per-tenant (office_*) + the TENANT_SCHEMA block for new tenants. Idempotent / replayable.

-- Existing tenants.
DO $tenant$
DECLARE
  schema_name text;
BEGIN
  FOR schema_name IN
    SELECT nspname FROM pg_namespace WHERE nspname LIKE 'office\_%' ESCAPE '\' ORDER BY nspname
  LOOP
    IF to_regclass(format('%I.deals', schema_name)) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE format(
      'ALTER TABLE %I.deals ADD COLUMN IF NOT EXISTS rfp_bidboard_attempt_at timestamptz',
      schema_name
    );
  END LOOP;
END $tenant$;

-- New tenants: cloned by the office provisioner (office_dallas -> new schema). Runs idempotently for
-- office_dallas at migration time too (redundant with the DO-loop above, guarded by IF NOT EXISTS).
-- TENANT_SCHEMA_START
ALTER TABLE office_dallas.deals ADD COLUMN IF NOT EXISTS rfp_bidboard_attempt_at timestamptz;
-- TENANT_SCHEMA_END
