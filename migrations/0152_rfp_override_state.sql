-- RFP override-approval delivery state (builds on migration 0151's second-look review columns).
--
-- When a reviewer approves a declined RFP, the CRM no longer "re-submits" it; it calls SyncHub's authoritative
-- override-approve endpoint, which runs the Playwright Bid Board project creation asynchronously. While that runs
-- the deal is parked in rfp_override_state='approving' (still rfp_approval_status='declined'); SyncHub then posts
-- a bid-board-created callback with status 'created' (→ linked + advanced to estimating + state cleared) or
-- 'failed' (→ rfp_override_state='failed' + rfp_override_error, deal stays declined and re-tryable).
--
-- Additive and idempotent across existing tenant schemas and reusable for future tenant schema provisioning.

DO $$
DECLARE
  tenant_schema text;
BEGIN
  FOR tenant_schema IN
    SELECT nspname
      FROM pg_namespace
     WHERE nspname LIKE 'office\_%' ESCAPE '\'
     ORDER BY nspname
  LOOP
    IF to_regclass(format('%I.deals', tenant_schema)) IS NOT NULL THEN
      -- rfp_override_state: NULL (no override in flight) | 'approving' (Playwright running) | 'failed' (retryable).
      EXECUTE format('ALTER TABLE %I.deals ADD COLUMN IF NOT EXISTS rfp_override_state text', tenant_schema);
      EXECUTE format('ALTER TABLE %I.deals ADD COLUMN IF NOT EXISTS rfp_override_error text', tenant_schema);
    END IF;
  END LOOP;
END $$;

-- TENANT_SCHEMA_START
DO $tenant$
BEGIN
  IF to_regclass('deals') IS NULL THEN
    RETURN;
  END IF;

  ALTER TABLE deals ADD COLUMN IF NOT EXISTS rfp_override_state text;
  ALTER TABLE deals ADD COLUMN IF NOT EXISTS rfp_override_error text;
END
$tenant$;
-- TENANT_SCHEMA_END
