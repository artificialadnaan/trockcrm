-- Migration 0159: manual-override marker for awarded_amount on bid-board-owned deals.
--
-- `awarded_amount_overridden` is set ONLY by a genuine admin/director manual edit through the
-- deal create/update user-input paths. The #688 won-transition seed (awarded = bid_estimate) is
-- automatic and never sets it. When true, the Procore mirror (buildBidBoardMirrorUpdate) skips
-- awarded_amount entirely — a human-set value is never overwritten by a sync, permanently.
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
      'ALTER TABLE %I.deals ADD COLUMN IF NOT EXISTS awarded_amount_overridden boolean NOT NULL DEFAULT false',
      schema_name
    );
  END LOOP;
END $tenant$;

-- New tenants: cloned by the office provisioner (office_dallas -> new schema). Runs idempotently for
-- office_dallas at migration time too (redundant with the DO-loop above, guarded by IF NOT EXISTS).
-- TENANT_SCHEMA_START
ALTER TABLE office_dallas.deals ADD COLUMN IF NOT EXISTS awarded_amount_overridden boolean NOT NULL DEFAULT false;
-- TENANT_SCHEMA_END
